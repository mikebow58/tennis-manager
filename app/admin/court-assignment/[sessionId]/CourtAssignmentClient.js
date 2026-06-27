'use client'

/**
 * CourtAssignmentClient.js
 *
 * Interactive court assignment review and approval UI, in two steps:
 *
 *   STEP 1 — 'edit': staging editor. All changes are LOCAL STATE only.
 *   STEP 2 — 'confirm': plain-language summary before the Approve POST fires.
 *
 * TEAM PAIRING:
 *   Procedure 2 assigns each complete court's 4 players into two teams using
 *   snake pairing. A "Change teams" dropdown per court shows all 3 possible
 *   pairings; selecting one re-assigns all 4 players in one action.
 *
 * PER-COURT PARTNER SETTING:
 *   Each court has a "Partners" dropdown defaulting to the session format.
 *   The organiser can override this per court independently. For courts in a
 *   rotation pairing, this per-court setting is ignored — the session format
 *   governs both courts in the pairing. The court notes field handles any
 *   exception within a paired rotation.
 *
 * COURT NUMBER WARNING:
 *   Courts without an assigned court number are shown in red on the
 *   confirmation screen. Non-blocking.
 *
 * FORMAT INSTRUCTION LOGIC:
 *   - Court in a rotation pairing → session format (ignores per-court override)
 *     Full text: "Winners to Court X, Losers to Court Y · Switch/Keep partners"
 *   - Court NOT in a rotation pairing → per-court partnerSetting override
 *     Text: "Switch partners each set" or "Keep partners each set"
 */

import { useState, useMemo, useCallback } from 'react'

const SKILL_LABELS = {
  1: '3.0-', 2: '3.0', 3: 'Str 3.0', 4: '3.5',
  5: 'Str 3.5', 6: '4.0', 7: 'Str 4.0', 8: '4.5+',
}

function getSkillLabel(skillAdmin, skillSelf) {
  if (skillAdmin) return SKILL_LABELS[skillAdmin] ?? `L${skillAdmin}`
  if (skillSelf) return `Self: ${skillSelf}`
  return '—'
}

const PARTNER_LABELS = {
  switch_partners: 'Switch partners each set',
  paired_rotation: 'Keep partners each set',
}

/**
 * Returns the format instruction text for one court.
 *
 * If the court is in a rotation pairing, the session format governs and the
 * per-court override is ignored. Otherwise the per-court partnerSetting is used.
 *
 * @param {string|null} partnerSetting   — per-court override ('switch_partners' | 'paired_rotation')
 * @param {string|null} sessionFormat    — session-level default
 * @param {object|null} rotationPairing  — rotation row for this court (if any)
 * @param {Function}    getCourtLabel    — (letter) => display string e.g. "Court 3"
 * @returns {string}
 */
function buildFormatInstruction(partnerSetting, sessionFormat, rotationPairing, getCourtLabel) {
  if (rotationPairing) {
    // Court is in a paired rotation — session format governs, override ignored.
    const partnerText = sessionFormat === 'switch_partners'
      ? 'Switch partners each set'
      : 'Keep partners each set'
    const winnersLabel = getCourtLabel(rotationPairing.winnersCourtLetter ?? rotationPairing.winners_court_letter)
    const secondLabel  = getCourtLabel(rotationPairing.secondCourtLetter  ?? rotationPairing.second_court_letter)
    return `Winners to ${winnersLabel}, Losers to ${secondLabel} · ${partnerText}`
  }

  // No rotation — use the per-court override (fall back to session format).
  const effective = partnerSetting ?? sessionFormat ?? 'paired_rotation'
  return PARTNER_LABELS[effective] ?? 'Keep partners each set'
}

// ---------------------------------------------------------------------------
// Pairing helpers
// ---------------------------------------------------------------------------
function generatePairingOptions(players) {
  if (players.length !== 4) return []
  const [a, b, c, d] = players
  return [
    { team1: [a, b], team2: [c, d] },
    { team1: [a, c], team2: [b, d] },
    { team1: [a, d], team2: [b, c] },
  ]
}

function pairingLabel(option) {
  const t1 = option.team1.map(p => p.firstName).join(' & ')
  const t2 = option.team2.map(p => p.firstName).join(' & ')
  return `${t1}  vs  ${t2}`
}

function pairingKey(option) {
  return option.team1.map(p => p.playerId).sort().join(',')
}

function currentPairingKey(players) {
  if (players.length !== 4) return null
  const team1Ids = players.filter(p => p.teamNumber === 1).map(p => p.playerId).sort()
  if (team1Ids.length !== 2) return null
  return team1Ids.join(',')
}

function groupPlayersByTeam(players) {
  const groups = { 1: [], 2: [], unassigned: [] }
  for (const p of players) {
    if (p.teamNumber === 1) groups[1].push(p)
    else if (p.teamNumber === 2) groups[2].push(p)
    else groups.unassigned.push(p)
  }
  return groups
}

// ---------------------------------------------------------------------------
// buildInitialState
// ---------------------------------------------------------------------------
function buildInitialState(daySessions, courtAssignments, availabilityRecords) {
  const availByPlayer = {}
  for (const av of availabilityRecords) availByPlayer[av.player_id] = av

  const sessionById = {}
  for (const s of daySessions) sessionById[s.id] = s

  const courtMap = {}

  for (const ca of courtAssignments) {
    const session = sessionById[ca.session_id]
    if (!session) continue
    const key = ca.court_letter

    if (!courtMap[key]) {
      courtMap[key] = {
        courtLetter: ca.court_letter,
        courtNumber: ca.court_number ?? null,
        sessionId: ca.session_id,
        locationId: ca.location_id,
        locationName: session.locations?.name ?? 'Unknown location',
        courtsAvailable: session.courts_available ?? 8,
        totalCourts: session.locations?.total_courts ?? null,
        sessionFormat: session.format ?? null,
        // Per-court partner override. Initialised from the stored value if
        // one exists (organiser already edited and saved), otherwise from
        // the session format (the default).
        partnerSetting: ca.partner_setting ?? session.format ?? 'paired_rotation',
        players: [],
      }
    }

    const av = availByPlayer[ca.player_id]
    courtMap[key].players.push({
      playerId: ca.player_id,
      availabilityId: av?.id ?? null,
      sessionId: ca.session_id,
      locationId: ca.location_id,
      teamNumber: ca.team_number ?? null,
      firstName: ca.players?.first_name ?? '?',
      lastName: ca.players?.last_name ?? '?',
      skillAdmin: ca.players?.skill_admin ?? null,
      skillSelf: ca.players?.skill_self ?? null,
    })
  }

  const sortedCourts = {}
  for (const key of Object.keys(courtMap).sort()) sortedCourts[key] = courtMap[key]

  return { courts: sortedCourts, unassigned: [] }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function CourtAssignmentClient({
  anchorSessionId, weekId, sessionDate, sessionDateLabel,
  daySessions, courtAssignments, availabilityRecords,
  activeLocations, alreadyFinalised,
}) {
  const [state, setState] = useState(() =>
    buildInitialState(daySessions, courtAssignments, availabilityRecords)
  )
  const [rotations, setRotations] = useState([])
  const [courtNotes, setCourtNotes] = useState({})
  const [step, setStep] = useState('edit')
  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState(null)

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------
  const courtsByLocation = useMemo(() => {
    const grouped = {}
    for (const [key, court] of Object.entries(state.courts)) {
      const locName = court.locationName
      if (!grouped[locName]) {
        grouped[locName] = {
          locationId: court.locationId,
          courtsAvailable: court.courtsAvailable,
          totalCourts: court.totalCourts ?? null,
          courts: {},
        }
      }
      grouped[locName].courts[key] = court
    }
    return grouped
  }, [state.courts])

  const allCourtLetters = useMemo(() => Object.keys(state.courts), [state.courts])

  const invalidCourts = useMemo(() =>
    Object.entries(state.courts)
      .filter(([, c]) => c.players.length !== 4)
      .map(([key, c]) => ({ key, letter: c.courtLetter, count: c.players.length })),
    [state.courts]
  )

  const duplicateCourtNumbers = useMemo(() => {
    const seen = {}
    const dupes = new Set()
    for (const court of Object.values(state.courts)) {
      if (court.courtNumber == null) continue
      const locId = court.locationId
      if (!seen[locId]) seen[locId] = new Set()
      if (seen[locId].has(court.courtNumber)) dupes.add(`${locId}:${court.courtNumber}`)
      seen[locId].add(court.courtNumber)
    }
    return dupes
  }, [state.courts])

  const canApprove = invalidCourts.length === 0 && duplicateCourtNumbers.size === 0

  const locationSummaries = useMemo(() =>
    Object.entries(courtsByLocation).map(([locName, locData]) => {
      const courtCount = Object.keys(locData.courts).length
      const isNewLocation = locData.courtsAvailable == null
      const capacityBound = isNewLocation ? locData.totalCourts : locData.courtsAvailable
      return {
        locationName: locName, locationId: locData.locationId,
        courtsAvailable: locData.courtsAvailable, totalCourts: locData.totalCourts,
        isNewLocation, courtCount, playerCount: courtCount * 4,
        overCapacity: capacityBound != null && courtCount > capacityBound,
        capacityBound,
      }
    }),
    [courtsByLocation]
  )

  const overCapacityLocations = useMemo(() => locationSummaries.filter(s => s.overCapacity), [locationSummaries])

  const validationMessage = useMemo(() => {
    const messages = []
    for (const { letter, count } of invalidCourts) {
      const diff = count < 4 ? `needs ${4 - count} more` : `has ${count - 4} too many`
      messages.push(`Court ${letter} ${diff} player${count !== 3 ? 's' : ''}`)
    }
    if (duplicateCourtNumbers.size > 0) messages.push('Two courts at the same location share a court number')
    return messages
  }, [invalidCourts, duplicateCourtNumbers])

  const assignmentEmailCount = useMemo(
    () => Object.values(state.courts).reduce((sum, c) => sum + c.players.length, 0),
    [state.courts]
  )

  const allLocations = useMemo(() => {
    const seen = new Map()
    for (const court of Object.values(state.courts)) {
      if (!seen.has(court.locationId)) {
        seen.set(court.locationId, {
          locationId: court.locationId, locationName: court.locationName,
          sessionId: court.sessionId, courtsAvailable: court.courtsAvailable,
          totalCourts: court.totalCourts ?? null, isNew: false,
        })
      }
    }
    for (const loc of activeLocations ?? []) {
      if (!seen.has(loc.id)) {
        seen.set(loc.id, {
          locationId: loc.id, locationName: loc.name,
          sessionId: `new:${loc.id}`, courtsAvailable: null,
          totalCourts: loc.total_courts ?? null, isNew: true,
        })
      }
    }
    return Array.from(seen.values())
  }, [state.courts, activeLocations])

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const handleCourtNumberChange = useCallback((courtKey, value) => {
    setState(prev => ({
      ...prev,
      courts: {
        ...prev.courts,
        [courtKey]: { ...prev.courts[courtKey], courtNumber: value === '' ? null : parseInt(value, 10) },
      },
    }))
  }, [])

  /** Updates the per-court partner setting override. */
  const handlePartnerSettingChange = useCallback((courtKey, value) => {
    setState(prev => ({
      ...prev,
      courts: {
        ...prev.courts,
        [courtKey]: { ...prev.courts[courtKey], partnerSetting: value },
      },
    }))
  }, [])

  const handleChangePairing = useCallback((courtKey, selectedKey) => {
    setState(prev => {
      const court = prev.courts[courtKey]
      if (!court || court.players.length !== 4) return prev
      const options = generatePairingOptions(court.players)
      const chosen = options.find(o => pairingKey(o) === selectedKey)
      if (!chosen) return prev
      const team1Ids = new Set(chosen.team1.map(p => p.playerId))
      const newPlayers = court.players.map(p => ({ ...p, teamNumber: team1Ids.has(p.playerId) ? 1 : 2 }))
      return { ...prev, courts: { ...prev.courts, [courtKey]: { ...court, players: newPlayers } } }
    })
  }, [])

  const handleMovePlayer = useCallback((fromCourtKey, playerId, toCourtKey) => {
    if (fromCourtKey === toCourtKey) return
    setState(prev => {
      const fromCourt = prev.courts[fromCourtKey]
      const toCourt = prev.courts[toCourtKey]
      if (!fromCourt || !toCourt) return prev
      const player = fromCourt.players.find(p => p.playerId === playerId)
      if (!player) return prev
      const movedPlayer = { ...player, teamNumber: null, sessionId: toCourt.sessionId, locationId: toCourt.locationId }
      return {
        ...prev,
        courts: {
          ...prev.courts,
          [fromCourtKey]: { ...fromCourt, players: fromCourt.players.filter(p => p.playerId !== playerId) },
          [toCourtKey]: { ...toCourt, players: [...toCourt.players, movedPlayer] },
        },
      }
    })
  }, [])

  const handleMoveFromUnassigned = useCallback((playerId, toCourtKey) => {
    setState(prev => {
      const toCourt = prev.courts[toCourtKey]
      if (!toCourt) return prev
      const player = prev.unassigned.find(p => p.playerId === playerId)
      if (!player) return prev
      const movedPlayer = { ...player, teamNumber: null, sessionId: toCourt.sessionId, locationId: toCourt.locationId }
      return {
        ...prev,
        unassigned: prev.unassigned.filter(p => p.playerId !== playerId),
        courts: { ...prev.courts, [toCourtKey]: { ...toCourt, players: [...toCourt.players, movedPlayer] } },
      }
    })
  }, [])

  const handleMoveCourtToLocation = useCallback((courtKey, destination) => {
    setState(prev => {
      const court = prev.courts[courtKey]
      if (!court) return prev
      const movedPlayers = court.players.map(p => ({ ...p, sessionId: destination.sessionId, locationId: destination.locationId }))
      return {
        ...prev,
        courts: {
          ...prev.courts,
          [courtKey]: {
            ...court,
            locationId: destination.locationId, locationName: destination.locationName,
            sessionId: destination.sessionId, courtsAvailable: destination.courtsAvailable,
            totalCourts: destination.totalCourts, courtNumber: null,
            players: movedPlayers,
            // partnerSetting travels with the court unchanged
          },
        },
      }
    })
    setRotations(prev => prev.filter(r => r.winnersCourtLetter !== courtKey && r.secondCourtLetter !== courtKey))
  }, [])

  const handleCancelCourt = useCallback((courtKey) => {
    setState(prev => {
      const court = prev.courts[courtKey]
      if (!court) return prev
      const playersWithOrigin = court.players.map(p => ({ ...p, originalCourtLetter: courtKey }))
      const newCourts = { ...prev.courts }
      delete newCourts[courtKey]
      return { courts: newCourts, unassigned: [...prev.unassigned, ...playersWithOrigin] }
    })
    setRotations(prev => prev.filter(r => r.winnersCourtLetter !== courtKey && r.secondCourtLetter !== courtKey))
    setCourtNotes(prev => { if (!(courtKey in prev)) return prev; const next = { ...prev }; delete next[courtKey]; return next })
  }, [])

  const handleAddRotation = useCallback((locationId) => {
    setRotations(prev => {
      const usedLetters = new Set(prev.flatMap(r => [r.winnersCourtLetter, r.secondCourtLetter]))
      const availableLetters = Object.entries(state.courts)
        .filter(([key, c]) => c.locationId === locationId && !usedLetters.has(key))
        .map(([key]) => key).sort()
      return [...prev, {
        id: crypto.randomUUID(), locationId,
        winnersCourtLetter: availableLetters[0] ?? '',
        secondCourtLetter: availableLetters[1] ?? '',
      }]
    })
  }, [state.courts])

  const handleUpdateRotation = useCallback((id, field, value) => {
    setRotations(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
  }, [])

  const handleRemoveRotation = useCallback((id) => {
    setRotations(prev => prev.filter(r => r.id !== id))
  }, [])

  const handleUpdateCourtNote = useCallback((courtLetter, value) => {
    setCourtNotes(prev => ({ ...prev, [courtLetter]: value }))
  }, [])

  const handleApprove = useCallback(async () => {
    if (!canApprove || submitting) return
    setSubmitting(true)
    setSubmitResult(null)

    const assignments = []
    for (const [, court] of Object.entries(state.courts)) {
      for (const player of court.players) {
        assignments.push({
          availabilityId: player.availabilityId, playerId: player.playerId,
          sessionId: player.sessionId, locationId: player.locationId,
          courtLetter: court.courtLetter, courtNumber: court.courtNumber ?? null,
          teamNumber: player.teamNumber ?? null,
          partnerSetting: court.partnerSetting ?? null,
          assignmentStatus: 'confirmed',
        })
      }
    }

    const usedPlaceholderLocationIds = new Set(
      Object.values(state.courts).filter(c => typeof c.sessionId === 'string' && c.sessionId.startsWith('new:')).map(c => c.locationId)
    )
    const newSessions = Array.from(usedPlaceholderLocationIds).map(locationId => ({
      placeholderSessionId: `new:${locationId}`, locationId,
      courtsAvailable: Object.values(state.courts).filter(c => c.locationId === locationId).length,
    }))

    const cancelledPlayers = state.unassigned.map(p => ({
      availabilityId: p.availabilityId, playerId: p.playerId, sessionId: p.sessionId,
    }))

    const rotationPairs = rotations
      .filter(r => r.winnersCourtLetter && r.secondCourtLetter)
      .map(r => ({
        winnersCourtLetter: r.winnersCourtLetter,
        secondCourtLetter: r.secondCourtLetter,
        rotationType: 'rotate_partners', // placeholder value; display uses session format
      }))

    const notes = Object.entries(courtNotes)
      .filter(([, note]) => note?.trim())
      .map(([courtLetter, note]) => ({ courtLetter, note: note.trim() }))

    try {
      const res = await fetch(`/api/admin/court-assignment/${anchorSessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments, cancelledPlayers, weekId, sessionDate, rotations: rotationPairs, courtNotes: notes, newSessions }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSubmitResult({ ok: false, error: data.message ?? 'Approval failed. Please try again.' })
      } else {
        setSubmitResult({ ok: true, courtsSent: data.courtsSent, warning: data.warning ?? null })
      }
    } catch {
      setSubmitResult({ ok: false, error: 'Network error. Please check your connection and try again.' })
    } finally {
      setSubmitting(false)
    }
  }, [canApprove, submitting, state, anchorSessionId, weekId, sessionDate, rotations, courtNotes])

  // ---------------------------------------------------------------------------
  // Already finalised
  // ---------------------------------------------------------------------------
  if (alreadyFinalised) {
    return (
      <div style={styles.page}>
        <div style={styles.header}><h1 style={styles.title}>Court Assignment</h1><p style={styles.subtitle}>{sessionDateLabel}</p></div>
        <div style={{ ...styles.card, background: '#f0fdf4', border: '1px solid #86efac' }}>
          <p style={{ color: '#166534', fontWeight: 600, margin: 0 }}>✓ Court assignments have already been finalised for this day. Player emails have been sent.</p>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Success screen
  // ---------------------------------------------------------------------------
  if (submitResult?.ok) {
    const urlSegments = typeof window !== 'undefined' ? window.location.pathname.split('/').filter(Boolean) : []
    const resolvedSessionId = urlSegments[urlSegments.length - 1] || ''
    return (
      <div style={styles.page}>
        <div style={styles.header}><h1 style={styles.title}>Court Assignment</h1><p style={styles.subtitle}>{sessionDateLabel}</p></div>
        <div style={{ ...styles.card, background: '#f0fdf4', border: '1px solid #86efac', marginBottom: '16px' }}>
          <p style={{ color: '#166534', fontWeight: 600, margin: '0 0 8px 0' }}>✓ Approved — {submitResult.courtsSent} player{submitResult.courtsSent !== 1 ? 's' : ''} notified</p>
          {submitResult.warning && <p style={{ color: '#92400e', fontSize: '14px', margin: 0 }}>Note: {submitResult.warning}</p>}
        </div>
        <a href={`/admin/court-assignment/${resolvedSessionId}/print`} target="_blank" rel="noopener noreferrer" style={{ background: '#2563eb', color: '#fff', padding: '10px 18px', borderRadius: '8px', fontWeight: 'bold', textDecoration: 'none', fontSize: '14px', display: 'inline-flex', alignItems: 'center' }}>
          <svg style={{ marginRight: '8px', width: '18px', height: '18px' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
          Print Lineup Sheet
        </a>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Confirmation view
  // ---------------------------------------------------------------------------
  if (step === 'confirm') {
    return (
      <ConfirmationView
        sessionDateLabel={sessionDateLabel} locationSummaries={locationSummaries}
        overCapacityLocations={overCapacityLocations} courtsByLocation={courtsByLocation}
        rotations={rotations} courtNotes={courtNotes} unassigned={state.unassigned}
        assignmentEmailCount={assignmentEmailCount} cancellationEmailCount={state.unassigned.length}
        submitting={submitting} submitResult={submitResult}
        onBack={() => setStep('edit')} onConfirm={handleApprove}
      />
    )
  }

  // ---------------------------------------------------------------------------
  // Main edit view
  // ---------------------------------------------------------------------------
  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Court Assignment</h1>
        <p style={styles.subtitle}>{sessionDateLabel}</p>
        <p style={styles.instructions}>Assign court numbers, adjust team pairings, and set partner rules as needed. Tap "Review changes" when ready — nothing is saved or sent until you confirm on the next screen.</p>
      </div>

      {Object.entries(courtsByLocation).map(([locationName, locData]) => (
        <div key={locationName} style={styles.locationSection}>
          {Object.keys(courtsByLocation).length > 1 && <h2 style={styles.locationHeading}>{locationName}</h2>}

          {Object.entries(locData.courts).map(([courtKey, court]) => {
            const isDuplicateNumber = court.courtNumber != null && duplicateCourtNumbers.has(`${court.locationId}:${court.courtNumber}`)
            const numbersUsedAtLocation = new Set(
              Object.values(state.courts)
                .filter(c => c.locationId === court.locationId && c.courtLetter !== courtKey && c.courtNumber != null)
                .map(c => c.courtNumber)
            )
            const isTentativeCourt = court.players.length < 4
            const teamGroups = groupPlayersByTeam(court.players)
            const pairingOptions = court.players.length === 4 ? generatePairingOptions(court.players) : []
            const activePairingKey = currentPairingKey(court.players)

            // Is this court part of a rotation pairing?
            const rotationForCourt = rotations.find(r =>
              r.winnersCourtLetter === courtKey || r.secondCourtLetter === courtKey
            ) ?? null
            const isInRotation = rotationForCourt != null

            // Format instruction shown on the edit view card.
            const formatInstruction = buildFormatInstruction(
              court.partnerSetting,
              court.sessionFormat,
              rotationForCourt,
              (letter) => {
                const c = state.courts[letter]
                return c?.courtNumber != null ? `Court ${c.courtNumber}` : `Court ${letter}`
              }
            )

            return (
              <div key={courtKey} style={{ ...styles.courtCard, borderColor: isTentativeCourt ? '#f59e0b' : '#e5e7eb', background: isTentativeCourt ? '#fffbeb' : '#fff' }}>
                {/* Header */}
                <div style={styles.courtCardHeader}>
                  <div style={styles.courtLetterBadge}>Court {courtKey}</div>

                  <div style={styles.courtNumberRow}>
                    <label style={styles.courtNumberLabel} htmlFor={`court-number-${courtKey}`}>Court #</label>
                    <select id={`court-number-${courtKey}`} value={court.courtNumber ?? ''} onChange={e => handleCourtNumberChange(courtKey, e.target.value)} style={{ ...styles.courtNumberSelect, borderColor: isDuplicateNumber ? '#ef4444' : '#d1d5db' }}>
                      <option value=''>— assign —</option>
                      {Array.from({ length: locData.courtsAvailable ?? locData.totalCourts ?? 8 }, (_, i) => i + 1).map(n => (
                        <option key={n} value={n} disabled={numbersUsedAtLocation.has(n)}>{n}{numbersUsedAtLocation.has(n) ? ' (taken)' : ''}</option>
                      ))}
                    </select>
                  </div>

                  {allLocations.length > 1 && (
                    <div style={styles.courtNumberRow}>
                      <label style={styles.courtNumberLabel} htmlFor={`court-location-${courtKey}`}>Move to</label>
                      <select id={`court-location-${courtKey}`} value='' onChange={e => { const dest = allLocations.find(l => String(l.locationId) === e.target.value); if (dest) handleMoveCourtToLocation(courtKey, dest) }} style={styles.courtNumberSelect} aria-label={`Move Court ${courtKey} to a different location`}>
                        <option value=''>— this location —</option>
                        {allLocations.filter(l => l.locationId !== court.locationId).map(l => (
                          <option key={l.locationId} value={l.locationId}>{l.locationName}{l.isNew ? ' (new)' : ''}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {isTentativeCourt && (
                    <button onClick={() => { if (window.confirm(`Cancel Court ${courtKey}? The ${court.players.length} player(s) on this court will be moved to the unassigned pool and cancelled when you approve.`)) handleCancelCourt(courtKey) }} style={styles.cancelCourtButton}>Cancel court</button>
                  )}
                </div>

                {isDuplicateNumber && <p style={styles.duplicateWarning}>⚠ Court number {court.courtNumber} is already assigned to another court at this location</p>}

                <p style={{ fontSize: '13px', color: court.players.length === 4 ? '#6b7280' : '#b45309', margin: '0 0 10px 0' }}>{court.players.length} / 4 players</p>

                {/* Team 1 */}
                {teamGroups[1].length > 0 && (
                  <div style={styles.teamBlock}>
                    <div style={styles.teamLabel}>Team 1</div>
                    {teamGroups[1].map(player => <PlayerRow key={player.playerId} player={player} currentCourtKey={courtKey} allCourtLetters={allCourtLetters} courts={state.courts} onMove={handleMovePlayer} />)}
                  </div>
                )}

                {/* Team 2 */}
                {teamGroups[2].length > 0 && (
                  <div style={styles.teamBlock}>
                    <div style={styles.teamLabel}>Team 2</div>
                    {teamGroups[2].map(player => <PlayerRow key={player.playerId} player={player} currentCourtKey={courtKey} allCourtLetters={allCourtLetters} courts={state.courts} onMove={handleMovePlayer} />)}
                  </div>
                )}

                {/* Unpaired */}
                {teamGroups.unassigned.length > 0 && (
                  <div style={styles.teamBlock}>
                    <div style={{ ...styles.teamLabel, color: '#b45309' }}>Not yet paired</div>
                    {teamGroups.unassigned.map(player => <PlayerRow key={player.playerId} player={player} currentCourtKey={courtKey} allCourtLetters={allCourtLetters} courts={state.courts} onMove={handleMovePlayer} />)}
                  </div>
                )}

                {/* Change teams dropdown */}
                {pairingOptions.length > 0 && (
                  <div style={styles.pairingRow}>
                    <label style={styles.pairingLabel} htmlFor={`pairing-${courtKey}`}>Change teams</label>
                    <select id={`pairing-${courtKey}`} value={activePairingKey ?? ''} onChange={e => handleChangePairing(courtKey, e.target.value)} style={styles.pairingSelect} aria-label={`Change team pairings for Court ${courtKey}`}>
                      {activePairingKey == null && <option value=''>— select pairing —</option>}
                      {pairingOptions.map(option => {
                        const key = pairingKey(option)
                        return <option key={key} value={key}>{pairingLabel(option)}</option>
                      })}
                    </select>
                  </div>
                )}

                {/* Per-court partners dropdown.
                    Disabled when court is in a rotation pairing — session format
                    governs in that case; a note explains this inline. */}
                <div style={styles.pairingRow}>
                  <label style={styles.pairingLabel} htmlFor={`partners-${courtKey}`}>Partners</label>
                  <select
                    id={`partners-${courtKey}`}
                    value={court.partnerSetting ?? court.sessionFormat ?? 'paired_rotation'}
                    onChange={e => handlePartnerSettingChange(courtKey, e.target.value)}
                    disabled={isInRotation}
                    style={{ ...styles.pairingSelect, color: isInRotation ? '#9ca3af' : '#111' }}
                    aria-label={`Partner setting for Court ${courtKey}`}
                  >
                    <option value='switch_partners'>Switch partners each set</option>
                    <option value='paired_rotation'>Keep partners each set</option>
                  </select>
                </div>

                {/* When in a rotation, explain why the dropdown is disabled */}
                {isInRotation && (
                  <p style={{ fontSize: '12px', color: '#9ca3af', margin: '4px 0 0 0', fontStyle: 'italic' }}>
                    Partner behaviour is set by the session format for courts in a rotation. Use the court note to communicate any exception.
                  </p>
                )}

                {/* Format instruction preview */}
                <div style={styles.formatInstructionRow}>
                  <span style={styles.formatInstructionText}>{formatInstruction}</span>
                </div>

                {/* Per-court note */}
                <div style={styles.noteRow}>
                  <label style={styles.noteLabel} htmlFor={`court-note-${courtKey}`}>Note for this court (optional)</label>
                  <input id={`court-note-${courtKey}`} type='text' value={courtNotes[courtKey] ?? ''} onChange={e => handleUpdateCourtNote(courtKey, e.target.value)} placeholder='e.g. Exception: keep partners all day' style={styles.noteInput} />
                </div>
              </div>
            )
          })}

          {/* Rotations panel */}
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

      {/* Unassigned pool */}
      {state.unassigned.length > 0 && (
        <div style={styles.unassignedSection}>
          <h2 style={styles.unassignedHeading}>Unassigned players ({state.unassigned.length})</h2>
          <p style={styles.unassignedNote}>These players will be sent a cancellation email when you approve. Move them to a court above if you want them to play.</p>
          {state.unassigned.map(player => <UnassignedPlayerRow key={player.playerId} player={player} allCourtLetters={allCourtLetters} courts={state.courts} onMove={handleMoveFromUnassigned} />)}
        </div>
      )}

      {validationMessage.length > 0 && (
        <div style={styles.validationBlock}>
          {validationMessage.map((msg, i) => <p key={i} style={{ margin: '0 0 4px 0', color: '#b45309', fontSize: '14px' }}>⚠ {msg}</p>)}
        </div>
      )}

      <div style={styles.approveRow}>
        <button onClick={() => setStep('confirm')} disabled={!canApprove} style={{ ...styles.approveButton, background: canApprove ? '#1e3a5f' : '#9ca3af', cursor: canApprove ? 'pointer' : 'not-allowed' }}>
          Review changes
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConfirmationView
// ---------------------------------------------------------------------------
function ConfirmationView({
  sessionDateLabel, locationSummaries, overCapacityLocations,
  courtsByLocation, rotations, courtNotes, unassigned,
  assignmentEmailCount, cancellationEmailCount,
  submitting, submitResult, onBack, onConfirm,
}) {
  const hasOverCapacity = overCapacityLocations.length > 0

  function getCourtLabel(letter, forRotation = false) {
    const court = findCourtByLetter(courtsByLocation, letter)
    if (court?.courtNumber != null) return `Court ${court.courtNumber}`
    return `Court ${letter}`
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Review for {sessionDateLabel}</h1>
        <button onClick={onBack} style={styles.backLink}>← Back to edit</button>
      </div>

      {locationSummaries.map(loc => (
        <div key={loc.locationName} style={styles.summaryCard}>
          <h2 style={styles.summaryLocationName}>{loc.locationName}{loc.isNewLocation ? ' (new)' : ''}</h2>
          <p style={styles.summaryLine}>{loc.courtCount} court{loc.courtCount !== 1 ? 's' : ''}, {loc.playerCount} players</p>

          {Object.entries(courtsByLocation[loc.locationName].courts)
            .sort(([, a], [, b]) =>
              a.courtNumber != null && b.courtNumber != null
                ? a.courtNumber - b.courtNumber
                : a.courtLetter.localeCompare(b.courtLetter)
            )
            .map(([courtKey, court]) => {
              const missingNumber = court.courtNumber == null
              const courtLabel = missingNumber
                ? `Court ${court.courtLetter} (number not yet assigned)`
                : `Court ${court.courtNumber}`

              // Team pairing display
              const groups = groupPlayersByTeam(court.players)
              const t1 = groups[1].map(p => p.firstName)
              const t2 = groups[2].map(p => p.firstName)
              const unpaired = groups.unassigned.map(p => `${p.firstName} ${p.lastName}`)
              const parts = []
              if (t1.length === 2) parts.push(t1.join(' & '))
              else if (t1.length > 0) parts.push(`Unpaired: ${t1.join(', ')}`)
              if (t2.length === 2) parts.push(t2.join(' & '))
              else if (t2.length > 0) parts.push(`Unpaired: ${t2.join(', ')}`)
              if (unpaired.length > 0) parts.push(`Not yet paired: ${unpaired.join(', ')}`)

              // Format instruction for this court
              const rotationForCourt = rotations.find(r =>
                r.winnersCourtLetter === courtKey || r.secondCourtLetter === courtKey
              ) ?? null
              const formatInstruction = buildFormatInstruction(
                court.partnerSetting, court.sessionFormat, rotationForCourt, getCourtLabel
              )

              // Court note (if any)
              const courtNote = courtNotes[courtKey]?.trim()

              return (
                <div key={courtKey} style={{ marginBottom: '12px', paddingLeft: '8px' }}>
                  {/* Court label — red when court number not yet assigned */}
                  <p style={{ fontSize: '14px', fontWeight: '600', color: missingNumber ? '#dc2626' : '#111', margin: '0 0 2px 0' }}>
                    {courtLabel}
                  </p>
                  {/* Player pairing */}
                  <p style={{ fontSize: '14px', color: '#444', margin: '0 0 2px 0' }}>
                    {parts.join('  vs  ')}
                  </p>
                  {/* Format instruction */}
                  <p style={{ fontSize: '12px', color: '#6b7280', margin: '0 0 2px 0', fontStyle: 'italic' }}>
                    {formatInstruction}
                  </p>
                  {/* Court note inline — no separate card needed */}
                  {courtNote && (
                    <p style={{ fontSize: '12px', color: '#92400e', margin: '0', fontStyle: 'italic' }}>
                      Note: {courtNote}
                    </p>
                  )}
                </div>
              )
            })}

          <p style={{ ...styles.summaryCapacityLine, color: loc.overCapacity ? '#dc2626' : '#6b7280' }}>
            {loc.capacityBound == null
              ? `${loc.locationName} — ${loc.courtCount} court${loc.courtCount !== 1 ? 's' : ''} assigned (new location)`
              : loc.overCapacity
                ? `⚠ ${loc.locationName} has up to ${loc.capacityBound} court${loc.capacityBound !== 1 ? 's' : ''} available, but ${loc.courtCount} ${loc.courtCount !== 1 ? 'are' : 'is'} assigned.`
                : `${loc.locationName} has ${loc.capacityBound} court${loc.capacityBound !== 1 ? 's' : ''} available — ${loc.courtCount} assigned ✓`}
          </p>
        </div>
      ))}

      {/* Cancellations */}
      {unassigned.length > 0 && (
        <div style={styles.unassignedSection}>
          <h2 style={styles.unassignedHeading}>{unassigned.length} player{unassigned.length !== 1 ? 's' : ''} will be notified they are not playing</h2>
          <p style={styles.unassignedNote}>{unassigned.map(p => `${p.firstName} ${p.lastName}`).join(', ')}</p>
        </div>
      )}

      {/* Email summary */}
      <div style={styles.summaryCard}>
        <h2 style={styles.summarySectionHeading}>What happens when you confirm</h2>
        <p style={styles.summaryLine}>{assignmentEmailCount} player{assignmentEmailCount !== 1 ? 's' : ''} will receive their court assignment.</p>
        {cancellationEmailCount > 0 && <p style={styles.summaryLine}>{cancellationEmailCount} player{cancellationEmailCount !== 1 ? 's' : ''} will receive a cancellation notice.</p>}
      </div>

      {hasOverCapacity && (
        <div style={styles.capacityBlock}>
          <p style={{ margin: '0 0 4px 0', color: '#991b1b', fontWeight: 600 }}>This can't be confirmed yet</p>
          {overCapacityLocations.map(loc => (
            <p key={loc.locationName} style={{ margin: '0 0 4px 0', color: '#991b1b', fontSize: '14px' }}>
              {loc.locationName} has up to {loc.capacityBound} court{loc.capacityBound !== 1 ? 's' : ''} available, but {loc.courtCount} {loc.courtCount !== 1 ? 'are' : 'is'} currently assigned there. Move {loc.courtCount - loc.capacityBound} court{(loc.courtCount - loc.capacityBound) !== 1 ? 's' : ''} to another location.
            </p>
          ))}
          <button onClick={onBack} style={styles.backToFixButton}>Back to edit</button>
        </div>
      )}

      {!hasOverCapacity && (
        <div style={styles.confirmActionsRow}>
          <button onClick={onBack} style={styles.backButton} disabled={submitting}>Back to edit</button>
          <button onClick={onConfirm} disabled={submitting} style={{ ...styles.approveButton, background: submitting ? '#9ca3af' : '#16a34a', cursor: submitting ? 'not-allowed' : 'pointer', flex: 1 }}>
            {submitting ? 'Sending…' : 'Confirm and notify players'}
          </button>
        </div>
      )}

      {submitResult?.ok === false && (
        <div style={styles.errorBlock}>
          <p style={{ margin: 0, color: '#991b1b' }}>Error: {submitResult.error}</p>
          <p style={{ margin: '8px 0 0 0', color: '#991b1b', fontSize: '13px' }}>Nothing has been sent. You can try again or go back to edit.</p>
        </div>
      )}
    </div>
  )
}

function findCourtByLetter(courtsByLocation, letter) {
  for (const locData of Object.values(courtsByLocation)) {
    if (locData.courts[letter]) return locData.courts[letter]
  }
  return null
}

function PlayerRow({ player, currentCourtKey, allCourtLetters, courts, onMove }) {
  const currentLocationId = courts[currentCourtKey]?.locationId
  const otherCourts = allCourtLetters.filter(k => k !== currentCourtKey && courts[k]?.locationId === currentLocationId)
  return (
    <div style={styles.playerRow}>
      <div style={styles.playerInfo}>
        <span style={styles.playerName}>{player.firstName} {player.lastName}</span>
        <span style={styles.playerSkill}>{getSkillLabel(player.skillAdmin, player.skillSelf)}</span>
      </div>
      {otherCourts.length > 0 && (
        <select value='' onChange={e => { if (e.target.value) onMove(currentCourtKey, player.playerId, e.target.value) }} style={styles.moveSelect} aria-label={`Move ${player.firstName} to another court`}>
          <option value=''>Move to…</option>
          {otherCourts.map(k => <option key={k} value={k}>Court {k} ({courts[k]?.players?.length ?? 0}/4)</option>)}
        </select>
      )}
    </div>
  )
}

function UnassignedPlayerRow({ player, allCourtLetters, courts, onMove }) {
  return (
    <div style={{ ...styles.playerRow, background: '#fef2f2', borderRadius: '6px', marginBottom: '6px' }}>
      <div style={styles.playerInfo}>
        <span style={styles.playerName}>{player.firstName} {player.lastName}</span>
        <span style={styles.playerSkill}>{getSkillLabel(player.skillAdmin, player.skillSelf)}</span>
        <span style={{ fontSize: '12px', color: '#9ca3af' }}>was Court {player.originalCourtLetter}</span>
      </div>
      {allCourtLetters.length > 0 && (
        <select value='' onChange={e => { if (e.target.value) onMove(player.playerId, e.target.value) }} style={styles.moveSelect} aria-label={`Move ${player.firstName} to a court`}>
          <option value=''>Move to court…</option>
          {allCourtLetters.map(k => <option key={k} value={k}>Court {k} — {courts[k]?.locationName ?? ''} ({courts[k]?.players?.length ?? 0}/4)</option>)}
        </select>
      )}
    </div>
  )
}

function RotationsPanel({ locationId, courtsAtLocation, rotations, onAdd, onUpdate, onRemove }) {
  const courtLetters = Object.keys(courtsAtLocation).sort()
  const usedByPairing = (excludeId) => {
    const used = new Set()
    for (const r of rotations) {
      if (r.id === excludeId) continue
      if (r.winnersCourtLetter) used.add(r.winnersCourtLetter)
      if (r.secondCourtLetter) used.add(r.secondCourtLetter)
    }
    return used
  }
  const allUsed = new Set(rotations.flatMap(r => [r.winnersCourtLetter, r.secondCourtLetter]))
  const canAddMore = courtLetters.filter(l => !allUsed.has(l)).length >= 2

  return (
    <div style={styles.rotationsPanel}>
      <h3 style={styles.rotationsHeading}>Rotations</h3>
      <p style={styles.rotationsNote}>Select which courts rotate with each other. Partner behaviour for paired courts is set by the session format — use a court note to communicate any exception.</p>
      {rotations.length === 0 && <p style={styles.rotationsEmptyNote}>No courts are paired for rotation. Add a pairing to set up a winners/losers rotation between two courts.</p>}
      {rotations.map(r => {
        const excluded = usedByPairing(r.id)
        return (
          <div key={r.id} style={styles.rotationRow}>
            <select value={r.winnersCourtLetter} onChange={e => onUpdate(r.id, 'winnersCourtLetter', e.target.value)} style={styles.rotationSelect} aria-label='Winners court'>
              <option value=''>— winners court —</option>
              {courtLetters.map(letter => <option key={letter} value={letter} disabled={excluded.has(letter) && letter !== r.winnersCourtLetter}>Court {letter}</option>)}
            </select>
            <span style={styles.rotationConnector}>↔</span>
            <select value={r.secondCourtLetter} onChange={e => onUpdate(r.id, 'secondCourtLetter', e.target.value)} style={styles.rotationSelect} aria-label='Second court'>
              <option value=''>— second court —</option>
              {courtLetters.map(letter => <option key={letter} value={letter} disabled={excluded.has(letter) && letter !== r.secondCourtLetter}>Court {letter}</option>)}
            </select>
            <div style={styles.rotationSubRow}>
              <label style={styles.rotationSubLabel}>Winners court:</label>
              <select value={r.winnersCourtLetter} onChange={e => { const nw = e.target.value; const ns = nw === r.winnersCourtLetter ? r.secondCourtLetter : r.winnersCourtLetter; onUpdate(r.id, 'winnersCourtLetter', nw); onUpdate(r.id, 'secondCourtLetter', ns) }} style={styles.rotationSelectSmall} aria-label='Which court is the winners court'>
                {[r.winnersCourtLetter, r.secondCourtLetter].filter(Boolean).map(letter => <option key={letter} value={letter}>Court {letter}</option>)}
              </select>
            </div>
            <button onClick={() => onRemove(r.id)} style={styles.removeRotationButton} aria-label='Remove this rotation pairing'>Remove</button>
          </div>
        )
      })}
      {canAddMore && <button onClick={() => onAdd(locationId)} style={styles.addRotationButton}>+ Add rotation pairing</button>}
    </div>
  )
}

const styles = {
  page: { maxWidth: '600px', margin: '0 auto', padding: '16px', fontFamily: 'sans-serif' },
  header: { marginBottom: '24px' },
  title: { fontSize: '24px', fontWeight: '700', color: '#111', margin: '0 0 4px 0' },
  subtitle: { fontSize: '16px', color: '#6b7280', margin: '0 0 12px 0' },
  instructions: { fontSize: '14px', color: '#444', lineHeight: '1.5', margin: 0 },
  locationSection: { marginBottom: '24px' },
  locationHeading: { fontSize: '18px', fontWeight: '600', color: '#374151', margin: '0 0 12px 0', paddingBottom: '8px', borderBottom: '2px solid #e5e7eb' },
  courtCard: { border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', marginBottom: '12px' },
  courtCardHeader: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '12px' },
  courtLetterBadge: { background: '#1e3a5f', color: '#fff', borderRadius: '6px', padding: '4px 10px', fontSize: '14px', fontWeight: '600' },
  courtNumberRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  courtNumberLabel: { fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap' },
  courtNumberSelect: { fontSize: '14px', padding: '6px 10px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', color: '#111', minWidth: '120px' },
  cancelCourtButton: { marginLeft: 'auto', background: 'transparent', border: '1px solid #f87171', color: '#dc2626', borderRadius: '6px', padding: '5px 10px', fontSize: '13px', cursor: 'pointer' },
  duplicateWarning: { color: '#dc2626', fontSize: '13px', margin: '0 0 8px 0' },
  teamBlock: { marginBottom: '10px' },
  teamLabel: { fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 4px 2px' },
  playerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: '#f9fafb', borderRadius: '6px', marginBottom: '4px', gap: '8px' },
  playerInfo: { display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 },
  playerName: { fontSize: '15px', fontWeight: '500', color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  playerSkill: { fontSize: '12px', color: '#6b7280', background: '#e5e7eb', borderRadius: '4px', padding: '2px 6px', whiteSpace: 'nowrap' },
  moveSelect: { fontSize: '13px', padding: '5px 8px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', color: '#111', flexShrink: 0, maxWidth: '180px' },
  pairingRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed #e5e7eb' },
  pairingLabel: { fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap', flexShrink: 0 },
  pairingSelect: { fontSize: '14px', padding: '7px 10px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', flex: 1 },
  formatInstructionRow: { marginTop: '8px', paddingTop: '6px' },
  formatInstructionText: { fontSize: '12px', color: '#6b7280', fontStyle: 'italic' },
  noteRow: { marginTop: '10px' },
  noteLabel: { display: 'block', fontSize: '12px', color: '#9ca3af', marginBottom: '4px' },
  noteInput: { width: '100%', fontSize: '14px', padding: '8px 10px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', color: '#111', boxSizing: 'border-box' },
  unassignedSection: { marginBottom: '24px', padding: '16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '10px' },
  unassignedHeading: { fontSize: '16px', fontWeight: '600', color: '#991b1b', margin: '0 0 8px 0' },
  unassignedNote: { fontSize: '13px', color: '#7f1d1d', margin: '0 0 12px 0', lineHeight: '1.5' },
  validationBlock: { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px' },
  approveRow: { marginBottom: '16px' },
  approveButton: { width: '100%', padding: '14px', borderRadius: '8px', border: 'none', color: '#fff', fontSize: '16px', fontWeight: '600' },
  errorBlock: { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '12px 16px' },
  card: { borderRadius: '10px', padding: '16px', marginBottom: '16px' },
  rotationsPanel: { border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', marginTop: '8px', marginBottom: '12px', background: '#f9fafb' },
  rotationsHeading: { fontSize: '15px', fontWeight: '600', color: '#374151', margin: '0 0 4px 0' },
  rotationsNote: { fontSize: '12px', color: '#9ca3af', margin: '0 0 10px 0', lineHeight: '1.5' },
  rotationsEmptyNote: { fontSize: '13px', color: '#6b7280', margin: '0 0 8px 0', lineHeight: '1.5' },
  rotationRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', padding: '10px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', marginBottom: '8px' },
  rotationSelect: { fontSize: '14px', padding: '6px 8px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', color: '#111' },
  rotationConnector: { fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap' },
  rotationSubRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  rotationSubLabel: { fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap' },
  rotationSelectSmall: { fontSize: '13px', padding: '5px 8px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', color: '#111' },
  removeRotationButton: { marginLeft: 'auto', background: 'transparent', border: '1px solid #f87171', color: '#dc2626', borderRadius: '6px', padding: '5px 10px', fontSize: '13px', cursor: 'pointer' },
  addRotationButton: { background: 'transparent', border: '1px dashed #9ca3af', color: '#374151', borderRadius: '6px', padding: '8px 12px', fontSize: '14px', cursor: 'pointer', width: '100%' },
  backLink: { background: 'transparent', border: 'none', color: '#2563eb', fontSize: '14px', padding: 0, cursor: 'pointer', textDecoration: 'underline' },
  summaryCard: { border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', marginBottom: '16px', background: '#fff' },
  summaryLocationName: { fontSize: '17px', fontWeight: '600', color: '#111', margin: '0 0 4px 0' },
  summarySectionHeading: { fontSize: '15px', fontWeight: '600', color: '#374151', margin: '0 0 8px 0' },
  summaryLine: { fontSize: '14px', color: '#444', lineHeight: '1.6', margin: '0 0 4px 0' },
  summaryCourtLine: { fontSize: '14px', color: '#444', lineHeight: '1.6', margin: '4px 0', paddingLeft: '8px' },
  summaryCapacityLine: { fontSize: '13px', margin: '8px 0 0 0' },
  capacityBlock: { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '10px', padding: '16px', marginBottom: '16px' },
  backToFixButton: { background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 16px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', marginTop: '8px' },
  confirmActionsRow: { display: 'flex', gap: '10px', marginBottom: '16px' },
  backButton: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: '8px', padding: '14px 16px', fontSize: '15px', fontWeight: '500', cursor: 'pointer' },
}