'use client'

/**
 * CourtAssignmentClient.js
 *
 * Interactive court assignment review and approval UI. All changes on this
 * screen are LOCAL STATE only — nothing writes to the database or sends any
 * email until the organiser clicks Approve.
 *
 * This component is the staging area for:
 *   1. Assigning real-world court numbers to court letters (A → 3, B → 1, etc.)
 *   2. Moving players between courts (via dropdown reassignment)
 *   3. Cancelling incomplete courts (moves players to an unassigned pool)
 *   4. Configuring racquet-rotation pairings between courts at the same location
 *   5. Adding optional freeform per-court notes (e.g. non-standard instructions)
 *   6. Approving — commits all changes in one transaction and sends emails
 *
 * VALIDATION:
 *   - Every active court card must have exactly 4 players before Approve is enabled.
 *   - Court numbers must be unique per location (duplicates shown as inline warning,
 *     Approve disabled).
 *   - Players in the unassigned pool are implicitly cancelled on Approve — they
 *     receive sendCourtCancellationNotice, not an assignment email.
 *
 * ROTATIONS & NOTES:
 *   - Rotation pairings link two courts at the same location for "winners up,
 *     losers down" racquet rotation. Each pairing designates a winners court
 *     and whether partners switch each set or stay together.
 *   - A court can belong to at most one pairing — handled via UI constraints.
 *   - Per-court freeform notes are optional and independent of rotation pairings.
 *   - Both are keyed by week_id + session_date (day-level concepts, like court
 *     letters) and committed to court_rotations / court_notes on Approve.
 *   - Cancelling a court removes any rotation pairing or note referencing it.
 *
 * MULTI-LOCATION:
 *   - All locations for the day are shown together on one screen.
 *   - Each location is a clearly labelled section.
 *   - Court number dropdowns are constrained to 1..courts_available per location.
 *   - Player move dropdowns list courts across ALL locations so the organiser
 *     can move players between venues.
 *
 * References:
 *   Phase 2 Section 4.5 (Procedure 2 outcomes)
 *   Automation Logic Section 8.2 (court assignment notification paths)
 */

import { useState, useMemo, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Skill label helper — maps 1–8 admin skill integer to a display string.
// Mirrors the V2 skill scale defined in the spec.
// ---------------------------------------------------------------------------
const SKILL_LABELS = {
  1: '3.0-', 2: '3.0', 3: 'Str 3.0', 4: '3.5',
  5: 'Str 3.5', 6: '4.0', 7: 'Str 4.0', 8: '4.5+',
}

function getSkillLabel(skillAdmin, skillSelf) {
  // Prefer admin rating; fall back to self-reported.
  if (skillAdmin) return SKILL_LABELS[skillAdmin] ?? `L${skillAdmin}`
  if (skillSelf) return `Self: ${skillSelf}`
  return '—'
}

// ---------------------------------------------------------------------------
// buildInitialState
//
// Converts the raw server props into the local state structure this component
// works with. Called once on mount via useMemo.
//
// State shape:
// {
//   courts: {
//     [courtKey: string]: {        // e.g. "A", "B", "C"
//       courtLetter: string,
//       courtNumber: number|null,  // null until organiser assigns
//       sessionId: number,         // which session this court belongs to
//       locationId: number,
//       locationName: string,
//       courtsAvailable: number,   // max court number allowed at this location
//       players: [{
//         playerId, availabilityId, sessionId, locationId,
//         firstName, lastName, skillAdmin, skillSelf
//       }]
//     }
//   },
//   unassigned: [{                 // players whose court was cancelled
//     playerId, availabilityId, sessionId, locationId,
//     firstName, lastName, skillAdmin, skillSelf,
//     originalCourtLetter         // for display context
//   }]
// }
// ---------------------------------------------------------------------------
function buildInitialState(daySessions, courtAssignments, availabilityRecords) {
  // Build a lookup: playerId → availability record (for availabilityId).
  const availByPlayer = {}
  for (const av of availabilityRecords) {
    availByPlayer[av.player_id] = av
  }

  // Build a lookup: sessionId → session (for location/court info).
  const sessionById = {}
  for (const s of daySessions) {
    sessionById[s.id] = s
  }

  // Group court_assignments by court_letter.
  // Each unique court_letter within a session is one court card.
  const courtMap = {}

  for (const ca of courtAssignments) {
    const session = sessionById[ca.session_id]
    if (!session) continue

    // Use court_letter as the key. On multi-location days, letters are
    // globally unique across the day (Procedure 2 assigns A, B, C across
    // all locations), so letter alone is a safe key.
    const key = ca.court_letter

    if (!courtMap[key]) {
      courtMap[key] = {
        courtLetter: ca.court_letter,
        // court_number may already be set if a prior partial approval occurred.
        courtNumber: ca.court_number ?? null,
        sessionId: ca.session_id,
        locationId: ca.location_id,
        locationName: session.locations?.name ?? 'Unknown location',
        courtsAvailable: session.courts_available ?? 8,
        players: [],
      }
    }

    // Enrich with player details for display.
    const av = availByPlayer[ca.player_id]
    courtMap[key].players.push({
      playerId: ca.player_id,
      availabilityId: av?.id ?? null,
      sessionId: ca.session_id,
      locationId: ca.location_id,
      firstName: ca.players?.first_name ?? '?',
      lastName: ca.players?.last_name ?? '?',
      skillAdmin: ca.players?.skill_admin ?? null,
      skillSelf: ca.players?.skill_self ?? null,
    })
  }

  // Sort courts alphabetically by letter so they render A, B, C, ...
  const sortedCourts = {}
  for (const key of Object.keys(courtMap).sort()) {
    sortedCourts[key] = courtMap[key]
  }

  return {
    courts: sortedCourts,
    unassigned: [], // starts empty; populated when organiser cancels a court
  }
}

// ---------------------------------------------------------------------------
// CourtAssignmentClient — main component
// ---------------------------------------------------------------------------
export default function CourtAssignmentClient({
  anchorSessionId,
  weekId,
  sessionDate,
  sessionDateLabel,
  daySessions,
  courtAssignments,
  availabilityRecords,
  alreadyFinalised,
}) {
  // ---------------------------------------------------------------------------
  // Local state — the staging area. All edits live here until Approve.
  // ---------------------------------------------------------------------------
  const [state, setState] = useState(() =>
    buildInitialState(daySessions, courtAssignments, availabilityRecords)
  )

  // Rotation pairings — array of pair objects, one per pairing the organiser
  // has configured. Empty array = no rotations configured (default).
  // Each entry: { id, locationId, winnersCourtLetter, secondCourtLetter, rotationType }
  // `id` is a local-only key (crypto.randomUUID()) for React list rendering —
  // not sent to the server, which keys rows by court letters instead.
  const [rotations, setRotations] = useState([])

  // Per-court freeform notes. Keyed by court letter. Empty/missing = no note.
  const [courtNotes, setCourtNotes] = useState({})

  // Submission state — tracks in-progress and result of the Approve POST.
  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState(null) // null | { ok, warning, error }

  // ---------------------------------------------------------------------------
  // Derived values — computed fresh on every render from current state.
  // ---------------------------------------------------------------------------

  // Group courts by location for sectioned rendering.
  const courtsByLocation = useMemo(() => {
    const grouped = {}
    for (const [key, court] of Object.entries(state.courts)) {
      const locName = court.locationName
      if (!grouped[locName]) {
        grouped[locName] = { locationId: court.locationId, courtsAvailable: court.courtsAvailable, courts: {} }
      }
      grouped[locName].courts[key] = court
    }
    return grouped
  }, [state.courts])

  // All active court letters in a flat array — used to populate move dropdowns.
  const allCourtLetters = useMemo(() => Object.keys(state.courts), [state.courts])

  // Validation: find courts that don't have exactly 4 players.
  const invalidCourts = useMemo(() => {
    return Object.entries(state.courts)
      .filter(([, court]) => court.players.length !== 4)
      .map(([key, court]) => ({ key, letter: court.courtLetter, count: court.players.length }))
  }, [state.courts])

  // Validation: find duplicate court numbers within the same location.
  const duplicateCourtNumbers = useMemo(() => {
    const seen = {} // locationId → Set of numbers
    const dupes = new Set()
    for (const court of Object.values(state.courts)) {
      if (court.courtNumber == null) continue
      const locId = court.locationId
      if (!seen[locId]) seen[locId] = new Set()
      if (seen[locId].has(court.courtNumber)) {
        dupes.add(`${locId}:${court.courtNumber}`)
      }
      seen[locId].add(court.courtNumber)
    }
    return dupes // set of "locationId:number" strings
  }, [state.courts])

  // Approve is enabled only when all courts have exactly 4 players AND no duplicate numbers.
  const canApprove = invalidCourts.length === 0 && duplicateCourtNumbers.size === 0

  // Build a human-readable validation message for display below the Approve button.
  const validationMessage = useMemo(() => {
    const messages = []
    for (const { letter, count } of invalidCourts) {
      const diff = count < 4 ? `needs ${4 - count} more` : `has ${count - 4} too many`
      messages.push(`Court ${letter} ${diff} player${count !== 3 ? 's' : ''}`)
    }
    if (duplicateCourtNumbers.size > 0) {
      messages.push('Two courts at the same location share a court number')
    }
    return messages
  }, [invalidCourts, duplicateCourtNumbers])

  // ---------------------------------------------------------------------------
  // Handlers — all update local state only; no API calls until Approve.
  // ---------------------------------------------------------------------------

  /**
   * Updates the court number for a given court letter.
   * Converts the select value to an integer (or null if blank).
   */
  const handleCourtNumberChange = useCallback((courtKey, value) => {
    setState(prev => ({
      ...prev,
      courts: {
        ...prev.courts,
        [courtKey]: {
          ...prev.courts[courtKey],
          courtNumber: value === '' ? null : parseInt(value, 10),
        },
      },
    }))
    console.log(`[CourtAssignment] Court ${courtKey} number set to: ${value}`)
  }, [])

  /**
   * Moves a player from their current court to a target court.
   * Updates both the source court (removes player) and target court (adds player).
   *
   * @param {string} fromCourtKey - Letter of the court the player is leaving
   * @param {number} playerId
   * @param {string} toCourtKey - Letter of the court the player is joining
   */
  const handleMovePlayer = useCallback((fromCourtKey, playerId, toCourtKey) => {
    if (fromCourtKey === toCourtKey) return // no-op

    setState(prev => {
      const fromCourt = prev.courts[fromCourtKey]
      const toCourt = prev.courts[toCourtKey]
      if (!fromCourt || !toCourt) return prev

      // Find the player record being moved.
      const player = fromCourt.players.find(p => p.playerId === playerId)
      if (!player) return prev

      // The player inherits the target court's session and location.
      const movedPlayer = {
        ...player,
        sessionId: toCourt.sessionId,
        locationId: toCourt.locationId,
      }

      console.log(`[CourtAssignment] Moving player ${player.firstName} ${player.lastName} from Court ${fromCourtKey} to Court ${toCourtKey}`)

      return {
        ...prev,
        courts: {
          ...prev.courts,
          [fromCourtKey]: {
            ...fromCourt,
            players: fromCourt.players.filter(p => p.playerId !== playerId),
          },
          [toCourtKey]: {
            ...toCourt,
            players: [...toCourt.players, movedPlayer],
          },
        },
      }
    })
  }, [])

  /**
   * Moves a player from the unassigned pool to a target court.
   */
  const handleMoveFromUnassigned = useCallback((playerId, toCourtKey) => {
    setState(prev => {
      const toCourt = prev.courts[toCourtKey]
      if (!toCourt) return prev

      const player = prev.unassigned.find(p => p.playerId === playerId)
      if (!player) return prev

      const movedPlayer = {
        ...player,
        sessionId: toCourt.sessionId,
        locationId: toCourt.locationId,
      }

      console.log(`[CourtAssignment] Moving ${player.firstName} ${player.lastName} from unassigned pool to Court ${toCourtKey}`)

      return {
        ...prev,
        unassigned: prev.unassigned.filter(p => p.playerId !== playerId),
        courts: {
          ...prev.courts,
          [toCourtKey]: {
            ...toCourt,
            players: [...toCourt.players, movedPlayer],
          },
        },
      }
    })
  }, [])

  /**
   * Cancels a court — removes the court card from the screen and moves all
   * its players to the unassigned pool. These players will be cancelled
   * (and emailed) when Approve is clicked.
   *
   * @param {string} courtKey - Letter of the court to cancel
   */
  const handleCancelCourt = useCallback((courtKey) => {
    setState(prev => {
      const court = prev.courts[courtKey]
      if (!court) return prev

      // Tag each player with their original court letter for display in the pool.
      const playersWithOrigin = court.players.map(p => ({
        ...p,
        originalCourtLetter: courtKey,
      }))

      console.log(`[CourtAssignment] Court ${courtKey} cancelled — ${court.players.length} player(s) moved to unassigned pool`)

      // Remove this court from the courts map; add its players to unassigned.
      const newCourts = { ...prev.courts }
      delete newCourts[courtKey]

      return {
        courts: newCourts,
        unassigned: [...prev.unassigned, ...playersWithOrigin],
      }
    })

    // A cancelled court can no longer be part of a rotation pairing —
    // remove any pairing referencing this letter.
    setRotations(prev => prev.filter(r =>
      r.winnersCourtLetter !== courtKey && r.secondCourtLetter !== courtKey
    ))

    // Drop any note attached to the cancelled court — it no longer applies.
    setCourtNotes(prev => {
      if (!(courtKey in prev)) return prev
      const next = { ...prev }
      delete next[courtKey]
      return next
    })
  }, [])

  /**
   * Adds a new rotation pairing row for the given location.
   * Defaults to the first two courts at that location not already part of
   * another pairing. If fewer than two unpaired courts remain, the row is
   * still added with whatever is available — the organiser can adjust via
   * the dropdowns, and an empty selection is treated as "incomplete pairing"
   * (excluded from the Approve payload).
   *
   * @param {number} locationId
   */
  const handleAddRotation = useCallback((locationId) => {
    setRotations(prev => {
      // Letters already claimed by an existing pairing — exclude from defaults.
      const usedLetters = new Set(prev.flatMap(r => [r.winnersCourtLetter, r.secondCourtLetter]))

      const availableLetters = Object.entries(state.courts)
        .filter(([key, c]) => c.locationId === locationId && !usedLetters.has(key))
        .map(([key]) => key)
        .sort()

      console.log(`[CourtAssignment] Adding rotation pairing for location ${locationId}. Available courts: ${availableLetters.join(', ')}`)

      return [
        ...prev,
        {
          id: crypto.randomUUID(), // local-only React key — not sent to server
          locationId,
          winnersCourtLetter: availableLetters[0] ?? '',
          secondCourtLetter: availableLetters[1] ?? '',
          rotationType: 'rotate_partners',
        },
      ]
    })
  }, [state.courts])

  /**
   * Updates a single field on an existing rotation pairing.
   * @param {string} id - local rotation row id
   * @param {string} field - 'winnersCourtLetter' | 'secondCourtLetter' | 'rotationType'
   * @param {string} value
   */
  const handleUpdateRotation = useCallback((id, field, value) => {
    setRotations(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
  }, [])

  /**
   * Removes a rotation pairing row entirely. Both courts become unpaired
   * and free to be selected in other pairing rows.
   * @param {string} id - local rotation row id
   */
  const handleRemoveRotation = useCallback((id) => {
    console.log(`[CourtAssignment] Removing rotation pairing ${id}`)
    setRotations(prev => prev.filter(r => r.id !== id))
  }, [])

  /**
   * Updates the freeform note for a given court letter.
   * @param {string} courtLetter
   * @param {string} value
   */
  const handleUpdateCourtNote = useCallback((courtLetter, value) => {
    setCourtNotes(prev => ({ ...prev, [courtLetter]: value }))
  }, [])

  // ---------------------------------------------------------------------------
  // Approve handler — POSTs the complete staged state to the approval route.
  // ---------------------------------------------------------------------------
  const handleApprove = useCallback(async () => {
    if (!canApprove || submitting) return

    setSubmitting(true)
    setSubmitResult(null)

    // Build the assignments array from current court state.
    // Each confirmed player needs: availabilityId, playerId, sessionId,
    // locationId, courtLetter, courtNumber, assignmentStatus.
    const assignments = []
    for (const [courtKey, court] of Object.entries(state.courts)) {
      for (const player of court.players) {
        assignments.push({
          availabilityId: player.availabilityId,
          playerId: player.playerId,
          sessionId: player.sessionId,
          locationId: player.locationId,
          courtLetter: court.courtLetter,
          courtNumber: court.courtNumber ?? null,
          assignmentStatus: 'confirmed',
        })
      }
    }

    // Build the cancelled players array from the unassigned pool.
    const cancelledPlayers = state.unassigned.map(p => ({
      availabilityId: p.availabilityId,
      playerId: p.playerId,
      sessionId: p.sessionId,
    }))

    // Build the rotations payload — only include pairings where both courts
    // are selected. An incomplete pairing (organiser added a row but didn't
    // finish selecting both courts) is silently dropped rather than sent
    // half-formed.
    const rotationPairs = rotations
      .filter(r => r.winnersCourtLetter && r.secondCourtLetter)
      .map(r => ({
        winnersCourtLetter: r.winnersCourtLetter,
        secondCourtLetter: r.secondCourtLetter,
        rotationType: r.rotationType,
      }))

    // Build the notes payload — only include non-empty, trimmed notes.
    const notes = Object.entries(courtNotes)
      .filter(([, note]) => note?.trim())
      .map(([courtLetter, note]) => ({ courtLetter, note: note.trim() }))

    console.log(
      `[CourtAssignment] Approving — ${assignments.length} assignment(s), ` +
      `${cancelledPlayers.length} cancellation(s), ${rotationPairs.length} rotation pair(s), ` +
      `${notes.length} note(s)`
    )

    try {
      const res = await fetch(`/api/admin/court-assignment/${anchorSessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments,
          cancelledPlayers,
          weekId,
          sessionDate,
          rotations: rotationPairs,
          courtNotes: notes,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        console.error('[CourtAssignment] Approve failed:', data)
        setSubmitResult({ ok: false, error: data.message ?? 'Approval failed. Please try again.' })
      } else {
        console.log('[CourtAssignment] Approve succeeded:', data)
        setSubmitResult({
          ok: true,
          courtsSent: data.courtsSent,
          warning: data.warning ?? null,
        })
      }
    } catch (err) {
      console.error('[CourtAssignment] Approve network error:', err)
      setSubmitResult({ ok: false, error: 'Network error. Please check your connection and try again.' })
    } finally {
      setSubmitting(false)
    }
  }, [canApprove, submitting, state, anchorSessionId, weekId, sessionDate, rotations, courtNotes])

  // ---------------------------------------------------------------------------
  // Already finalised — show read-only confirmation screen.
  // ---------------------------------------------------------------------------
  if (alreadyFinalised) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <h1 style={styles.title}>Court Assignment</h1>
          <p style={styles.subtitle}>{sessionDateLabel}</p>
        </div>
        <div style={{ ...styles.card, background: '#f0fdf4', border: '1px solid #86efac' }}>
          <p style={{ color: '#166534', fontWeight: 600, margin: 0 }}>
            ✓ Court assignments have already been finalised for this day. Player emails have been sent.
          </p>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Success screen — shown after a successful Approve.
  // ---------------------------------------------------------------------------
  if (submitResult?.ok) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <h1 style={styles.title}>Court Assignment</h1>
          <p style={styles.subtitle}>{sessionDateLabel}</p>
        </div>
        <div style={{ ...styles.card, background: '#f0fdf4', border: '1px solid #86efac' }}>
          <p style={{ color: '#166534', fontWeight: 600, margin: '0 0 8px 0' }}>
            ✓ Approved — {submitResult.courtsSent} player{submitResult.courtsSent !== 1 ? 's' : ''} notified
          </p>
          {submitResult.warning && (
            <p style={{ color: '#92400e', fontSize: '14px', margin: 0 }}>
              Note: {submitResult.warning}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Main render — the staging UI.
  // ---------------------------------------------------------------------------
  return (
    <div style={styles.page}>
      {/* Page header */}
      <div style={styles.header}>
        <h1 style={styles.title}>Court Assignment</h1>
        <p style={styles.subtitle}>{sessionDateLabel}</p>
        <p style={styles.instructions}>
          Assign court numbers, move players if needed, then tap Approve to notify everyone.
          Changes on this screen are not saved until you approve.
        </p>
      </div>

      {/* Court sections — one per location */}
      {Object.entries(courtsByLocation).map(([locationName, locData]) => (
        <div key={locationName} style={styles.locationSection}>
          {/* Show location name only on multi-location days (more than one location) */}
          {Object.keys(courtsByLocation).length > 1 && (
            <h2 style={styles.locationHeading}>{locationName}</h2>
          )}

          {/* Court cards for this location */}
          {Object.entries(locData.courts).map(([courtKey, court]) => {
            // Determine if this court number is a duplicate within its location.
            const isDuplicateNumber = court.courtNumber != null &&
              duplicateCourtNumbers.has(`${court.locationId}:${court.courtNumber}`)

            // Build the list of numbers already assigned to OTHER courts at this
            // location — these will be disabled in the dropdown.
            const numbersUsedAtLocation = new Set(
              Object.values(state.courts)
                .filter(c => c.locationId === court.locationId && c.courtLetter !== courtKey && c.courtNumber != null)
                .map(c => c.courtNumber)
            )

            const isTentativeCourt = court.players.length < 4

            return (
              <div
                key={courtKey}
                style={{
                  ...styles.courtCard,
                  borderColor: isTentativeCourt ? '#f59e0b' : '#e5e7eb',
                  background: isTentativeCourt ? '#fffbeb' : '#fff',
                }}
              >
                {/* Court card header: letter label + number selector + cancel button */}
                <div style={styles.courtCardHeader}>
                  <div style={styles.courtLetterBadge}>Court {courtKey}</div>

                  {/* Court number dropdown — constrained to 1..courts_available */}
                  <div style={styles.courtNumberRow}>
                    <label style={styles.courtNumberLabel} htmlFor={`court-number-${courtKey}`}>
                      Court #
                    </label>
                    <select
                      id={`court-number-${courtKey}`}
                      value={court.courtNumber ?? ''}
                      onChange={e => handleCourtNumberChange(courtKey, e.target.value)}
                      style={{
                        ...styles.courtNumberSelect,
                        borderColor: isDuplicateNumber ? '#ef4444' : '#d1d5db',
                      }}
                    >
                      <option value=''>— assign —</option>
                      {Array.from({ length: locData.courtsAvailable }, (_, i) => i + 1).map(n => (
                        <option
                          key={n}
                          value={n}
                          disabled={numbersUsedAtLocation.has(n)}
                        >
                          {n}{numbersUsedAtLocation.has(n) ? ' (taken)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Cancel court button — only shown on incomplete courts */}
                  {isTentativeCourt && (
                    <button
                      onClick={() => {
                        if (window.confirm(`Cancel Court ${courtKey}? The ${court.players.length} player(s) on this court will be moved to the unassigned pool and cancelled when you approve.`)) {
                          handleCancelCourt(courtKey)
                        }
                      }}
                      style={styles.cancelCourtButton}
                    >
                      Cancel court
                    </button>
                  )}
                </div>

                {/* Duplicate court number warning */}
                {isDuplicateNumber && (
                  <p style={styles.duplicateWarning}>
                    ⚠ Court number {court.courtNumber} is already assigned to another court at this location
                  </p>
                )}

                {/* Player count indicator */}
                <p style={{
                  fontSize: '13px',
                  color: court.players.length === 4 ? '#6b7280' : '#b45309',
                  margin: '0 0 8px 0',
                }}>
                  {court.players.length} / 4 players
                </p>

                {/* Player rows */}
                {court.players.map(player => (
                  <PlayerRow
                    key={player.playerId}
                    player={player}
                    currentCourtKey={courtKey}
                    allCourtLetters={allCourtLetters}
                    courts={state.courts}
                    onMove={handleMovePlayer}
                  />
                ))}

                {/* Optional per-court note — freeform, shown to players in
                    the assignment email and on the printed lineup sheet. */}
                <div style={styles.noteRow}>
                  <label style={styles.noteLabel} htmlFor={`court-note-${courtKey}`}>
                    Note for this court (optional)
                  </label>
                  <input
                    id={`court-note-${courtKey}`}
                    type='text'
                    value={courtNotes[courtKey] ?? ''}
                    onChange={e => handleUpdateCourtNote(courtKey, e.target.value)}
                    placeholder='e.g. Joe & John keep partners all day'
                    style={styles.noteInput}
                  />
                </div>
              </div>
            )
          })}

          {/* Rotations panel — only meaningful with 2+ courts at this location */}
          {Object.keys(locData.courts).length >= 2 && (
            <RotationsPanel
              locationId={locData.locationId}
              courtsAtLocation={locData.courts}
              rotations={rotations.filter(r => r.locationId === locData.locationId)}
              onAdd={handleAddRotation}
              onUpdate={handleUpdateRotation}
              onRemove={handleRemoveRotation}
            />
          )}
        </div>
      ))}

      {/* Unassigned pool — players whose court was cancelled */}
      {state.unassigned.length > 0 && (
        <div style={styles.unassignedSection}>
          <h2 style={styles.unassignedHeading}>
            Unassigned players ({state.unassigned.length})
          </h2>
          <p style={styles.unassignedNote}>
            These players will be sent a cancellation email when you approve.
            Move them to a court above if you want them to play.
          </p>
          {state.unassigned.map(player => (
            <UnassignedPlayerRow
              key={player.playerId}
              player={player}
              allCourtLetters={allCourtLetters}
              courts={state.courts}
              onMove={handleMoveFromUnassigned}
            />
          ))}
        </div>
      )}

      {/* Validation messages */}
      {validationMessage.length > 0 && (
        <div style={styles.validationBlock}>
          {validationMessage.map((msg, i) => (
            <p key={i} style={{ margin: '0 0 4px 0', color: '#b45309', fontSize: '14px' }}>
              ⚠ {msg}
            </p>
          ))}
        </div>
      )}

      {/* Approve button */}
      <div style={styles.approveRow}>
        <button
          onClick={handleApprove}
          disabled={!canApprove || submitting}
          style={{
            ...styles.approveButton,
            background: canApprove && !submitting ? '#16a34a' : '#9ca3af',
            cursor: canApprove && !submitting ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Approving…' : `Approve and notify players for ${sessionDateLabel}`}
        </button>
      </div>

      {/* Error message from a failed submit */}
      {submitResult?.ok === false && (
        <div style={styles.errorBlock}>
          <p style={{ margin: 0, color: '#991b1b' }}>
            Error: {submitResult.error}
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PlayerRow — one row within a court card.
// Shows player name, skill level, and a move-to dropdown.
// ---------------------------------------------------------------------------
function PlayerRow({ player, currentCourtKey, allCourtLetters, courts, onMove }) {
  const otherCourts = allCourtLetters.filter(k => k !== currentCourtKey)

  return (
    <div style={styles.playerRow}>
      <div style={styles.playerInfo}>
        <span style={styles.playerName}>
          {player.firstName} {player.lastName}
        </span>
        <span style={styles.playerSkill}>
          {getSkillLabel(player.skillAdmin, player.skillSelf)}
        </span>
      </div>

      {/* Move to court dropdown — only shown if there are other courts to move to */}
      {otherCourts.length > 0 && (
        <select
          value=''
          onChange={e => {
            if (e.target.value) onMove(currentCourtKey, player.playerId, e.target.value)
          }}
          style={styles.moveSelect}
          aria-label={`Move ${player.firstName} to another court`}
        >
          <option value=''>Move to…</option>
          {otherCourts.map(courtKey => (
            <option key={courtKey} value={courtKey}>
              Court {courtKey} — {courts[courtKey]?.locationName ?? ''}
              {' '}({courts[courtKey]?.players?.length ?? 0}/4)
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// UnassignedPlayerRow — one row in the unassigned pool.
// ---------------------------------------------------------------------------
function UnassignedPlayerRow({ player, allCourtLetters, courts, onMove }) {
  return (
    <div style={{ ...styles.playerRow, background: '#fef2f2', borderRadius: '6px', marginBottom: '6px' }}>
      <div style={styles.playerInfo}>
        <span style={styles.playerName}>
          {player.firstName} {player.lastName}
        </span>
        <span style={styles.playerSkill}>
          {getSkillLabel(player.skillAdmin, player.skillSelf)}
        </span>
        <span style={{ fontSize: '12px', color: '#9ca3af' }}>
          was Court {player.originalCourtLetter}
        </span>
      </div>

      {allCourtLetters.length > 0 && (
        <select
          value=''
          onChange={e => {
            if (e.target.value) onMove(player.playerId, e.target.value)
          }}
          style={styles.moveSelect}
          aria-label={`Move ${player.firstName} to a court`}
        >
          <option value=''>Move to court…</option>
          {allCourtLetters.map(courtKey => (
            <option key={courtKey} value={courtKey}>
              Court {courtKey} — {courts[courtKey]?.locationName ?? ''}
              {' '}({courts[courtKey]?.players?.length ?? 0}/4)
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RotationsPanel — manages racquet-rotation pairings for one location.
//
// Each pairing row lets the organiser pick two courts at this location,
// designate which is the "winners" court, and choose whether partners
// switch each set or stay together. A court can appear in at most one
// pairing — the dropdown options exclude letters already used by OTHER
// pairing rows (but still allow this row's own current selections).
// ---------------------------------------------------------------------------
function RotationsPanel({ locationId, courtsAtLocation, rotations, onAdd, onUpdate, onRemove }) {
  // All court letters at this location, sorted for stable dropdown ordering.
  const courtLetters = Object.keys(courtsAtLocation).sort()

  // Letters used by OTHER pairings (not the one currently being rendered) —
  // computed per-row below since "other" depends on which row we're in.
  const usedByPairing = (excludeId) => {
    const used = new Set()
    for (const r of rotations) {
      if (r.id === excludeId) continue
      if (r.winnersCourtLetter) used.add(r.winnersCourtLetter)
      if (r.secondCourtLetter) used.add(r.secondCourtLetter)
    }
    return used
  }

  // Whether there are at least 2 unpaired courts left to start a new pairing.
  const allUsed = new Set(rotations.flatMap(r => [r.winnersCourtLetter, r.secondCourtLetter]))
  const unpairedCount = courtLetters.filter(l => !allUsed.has(l)).length
  const canAddMore = unpairedCount >= 2

  return (
    <div style={styles.rotationsPanel}>
      <h3 style={styles.rotationsHeading}>Rotations</h3>

      {rotations.length === 0 && (
        <p style={styles.rotationsEmptyNote}>
          No courts are paired for rotation. Add a pairing if these courts should rotate players.
        </p>
      )}

      {rotations.map(r => {
        const excluded = usedByPairing(r.id)

        return (
          <div key={r.id} style={styles.rotationRow}>
            {/* Winners court selector */}
            <select
              value={r.winnersCourtLetter}
              onChange={e => onUpdate(r.id, 'winnersCourtLetter', e.target.value)}
              style={styles.rotationSelect}
              aria-label='Winners court'
            >
              <option value=''>— court —</option>
              {courtLetters.map(letter => (
                <option
                  key={letter}
                  value={letter}
                  // Allow this row's own current selections even if "used".
                  disabled={excluded.has(letter) && letter !== r.winnersCourtLetter}
                >
                  Court {letter}
                </option>
              ))}
            </select>

            <span style={styles.rotationConnector}>↔ rotates with</span>

            {/* Second court selector */}
            <select
              value={r.secondCourtLetter}
              onChange={e => onUpdate(r.id, 'secondCourtLetter', e.target.value)}
              style={styles.rotationSelect}
              aria-label='Second court'
            >
              <option value=''>— court —</option>
              {courtLetters.map(letter => (
                <option
                  key={letter}
                  value={letter}
                  disabled={excluded.has(letter) && letter !== r.secondCourtLetter}
                >
                  Court {letter}
                </option>
              ))}
            </select>

            {/* Which court is "winners" */}
            <div style={styles.rotationSubRow}>
              <label style={styles.rotationSubLabel}>Winners court:</label>
              <select
                value={r.winnersCourtLetter}
                onChange={e => {
                  // Swap winners/second so the chosen letter becomes winners.
                  const newWinners = e.target.value
                  const newSecond = newWinners === r.winnersCourtLetter ? r.secondCourtLetter : r.winnersCourtLetter
                  onUpdate(r.id, 'winnersCourtLetter', newWinners)
                  onUpdate(r.id, 'secondCourtLetter', newSecond)
                }}
                style={styles.rotationSelectSmall}
                aria-label='Which court is the winners court'
              >
                {[r.winnersCourtLetter, r.secondCourtLetter].filter(Boolean).map(letter => (
                  <option key={letter} value={letter}>Court {letter}</option>
                ))}
              </select>
            </div>

            {/* Partner behaviour */}
            <div style={styles.rotationSubRow}>
              <label style={styles.rotationSubLabel}>Partners:</label>
              <select
                value={r.rotationType}
                onChange={e => onUpdate(r.id, 'rotationType', e.target.value)}
                style={styles.rotationSelectSmall}
                aria-label='Partner rotation type'
              >
                <option value='rotate_partners'>Switch each set</option>
                <option value='keep_partners'>Keep same partner</option>
              </select>
            </div>

            <button
              onClick={() => onRemove(r.id)}
              style={styles.removeRotationButton}
              aria-label='Remove this rotation pairing'
            >
              Remove
            </button>
          </div>
        )
      })}

      {canAddMore && (
        <button onClick={() => onAdd(locationId)} style={styles.addRotationButton}>
          + Add rotation pairing
        </button>
      )}
    </div>
  )
}


// ---------------------------------------------------------------------------
// Inline styles — mobile-first, consistent with existing TGM admin UI.
// Dark navy header pattern is in the layout — this page uses the standard
// content area styling.
// ---------------------------------------------------------------------------
const styles = {
  page: {
    maxWidth: '600px',
    margin: '0 auto',
    padding: '16px',
    fontFamily: 'sans-serif',
  },
  header: {
    marginBottom: '24px',
  },
  title: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#111',
    margin: '0 0 4px 0',
  },
  subtitle: {
    fontSize: '16px',
    color: '#6b7280',
    margin: '0 0 12px 0',
  },
  instructions: {
    fontSize: '14px',
    color: '#444',
    lineHeight: '1.5',
    margin: 0,
  },
  locationSection: {
    marginBottom: '24px',
  },
  locationHeading: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#374151',
    margin: '0 0 12px 0',
    paddingBottom: '8px',
    borderBottom: '2px solid #e5e7eb',
  },
  courtCard: {
    border: '1px solid #e5e7eb',
    borderRadius: '10px',
    padding: '16px',
    marginBottom: '12px',
  },
  courtCardHeader: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '10px',
    marginBottom: '12px',
  },
  courtLetterBadge: {
    background: '#1e3a5f',
    color: '#fff',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '14px',
    fontWeight: '600',
  },
  courtNumberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  courtNumberLabel: {
    fontSize: '13px',
    color: '#6b7280',
    whiteSpace: 'nowrap',
  },
  courtNumberSelect: {
    fontSize: '14px',
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#fff',
    color: '#111',
    minWidth: '120px',
  },
  cancelCourtButton: {
    marginLeft: 'auto',
    background: 'transparent',
    border: '1px solid #f87171',
    color: '#dc2626',
    borderRadius: '6px',
    padding: '5px 10px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  duplicateWarning: {
    color: '#dc2626',
    fontSize: '13px',
    margin: '0 0 8px 0',
  },
  playerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    background: '#f9fafb',
    borderRadius: '6px',
    marginBottom: '6px',
    gap: '8px',
  },
  playerInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flex: 1,
    minWidth: 0,
  },
  playerName: {
    fontSize: '15px',
    fontWeight: '500',
    color: '#111',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  playerSkill: {
    fontSize: '12px',
    color: '#6b7280',
    background: '#e5e7eb',
    borderRadius: '4px',
    padding: '2px 6px',
    whiteSpace: 'nowrap',
  },
  moveSelect: {
    fontSize: '13px',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#fff',
    color: '#111',
    flexShrink: 0,
    maxWidth: '180px',
  },
  unassignedSection: {
    marginBottom: '24px',
    padding: '16px',
    background: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: '10px',
  },
  unassignedHeading: {
    fontSize: '16px',
    fontWeight: '600',
    color: '#991b1b',
    margin: '0 0 8px 0',
  },
  unassignedNote: {
    fontSize: '13px',
    color: '#7f1d1d',
    margin: '0 0 12px 0',
    lineHeight: '1.5',
  },
  validationBlock: {
    background: '#fffbeb',
    border: '1px solid #fcd34d',
    borderRadius: '8px',
    padding: '12px 16px',
    marginBottom: '16px',
  },
  approveRow: {
    marginBottom: '16px',
  },
  approveButton: {
    width: '100%',
    padding: '14px',
    borderRadius: '8px',
    border: 'none',
    color: '#fff',
    fontSize: '16px',
    fontWeight: '600',
    transition: 'background 0.15s',
  },
  errorBlock: {
    background: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: '8px',
    padding: '12px 16px',
  },
  card: {
    borderRadius: '10px',
    padding: '16px',
    marginBottom: '16px',
  },

  // -------------------------------------------------------------------------
  // Per-court note field
  // -------------------------------------------------------------------------
  noteRow: {
    marginTop: '8px',
  },
  noteLabel: {
    display: 'block',
    fontSize: '12px',
    color: '#9ca3af',
    marginBottom: '4px',
  },
  noteInput: {
    width: '100%',
    fontSize: '14px',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#fff',
    color: '#111',
    boxSizing: 'border-box',
  },

  // -------------------------------------------------------------------------
  // Rotations panel
  // -------------------------------------------------------------------------
  rotationsPanel: {
    border: '1px solid #e5e7eb',
    borderRadius: '10px',
    padding: '16px',
    marginTop: '8px',
    marginBottom: '12px',
    background: '#f9fafb',
  },
  rotationsHeading: {
    fontSize: '15px',
    fontWeight: '600',
    color: '#374151',
    margin: '0 0 8px 0',
  },
  rotationsEmptyNote: {
    fontSize: '13px',
    color: '#6b7280',
    margin: '0 0 8px 0',
    lineHeight: '1.5',
  },
  rotationRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '10px',
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    marginBottom: '8px',
  },
  rotationSelect: {
    fontSize: '14px',
    padding: '6px 8px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#fff',
    color: '#111',
  },
  rotationConnector: {
    fontSize: '13px',
    color: '#6b7280',
    whiteSpace: 'nowrap',
  },
  rotationSubRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  rotationSubLabel: {
    fontSize: '13px',
    color: '#6b7280',
    whiteSpace: 'nowrap',
  },
  rotationSelectSmall: {
    fontSize: '13px',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid #d1d5db',
    background: '#fff',
    color: '#111',
  },
  removeRotationButton: {
    marginLeft: 'auto',
    background: 'transparent',
    border: '1px solid #f87171',
    color: '#dc2626',
    borderRadius: '6px',
    padding: '5px 10px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  addRotationButton: {
    background: 'transparent',
    border: '1px dashed #9ca3af',
    color: '#374151',
    borderRadius: '6px',
    padding: '8px 12px',
    fontSize: '14px',
    cursor: 'pointer',
    width: '100%',
  },
}
