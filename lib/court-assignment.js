/**
 * lib/court-assignment.js
 *
 * Procedure 2 — Final Court Assignment
 *
 * Runs when a session is already closed (reminder sent) and one of the
 * following triggers fires:
 *   Trigger A: Session reaches full status after the reminder send
 *              (a sub or fill-in player is added). Event-driven, immediate.
 *   Trigger B: daily_6pm_court_assignment cron fires (18:00 day prior)
 *              and the session is still short.
 *
 * Multi-location support:
 *   On multi-location days, all sessions sharing the same week_id and
 *   session_date are treated as one unified pool. Players are optimised
 *   globally across all locations, with higher-skill players clustered
 *   at the first location (by courts_available desc, then location name
 *   asc as tiebreaker). Court letters are assigned globally (A = highest
 *   skill overall) and players are distributed to locations by skill band.
 *
 * Algorithm:
 *   1. Fetch unified pool (all confirmed + tentative availability records
 *      across all sessions for the day).
 *   2. Resolve each player's effective skill (skill_admin → mapped
 *      skill_self → default 4).
 *   3. Assign players to locations by skill band, respecting each
 *      location's courts_available capacity (highest skill → largest
 *      location first).
 *   4. Within each location, balance courts using the same optimisation
 *      as Procedure 1: minimise max skill gap across courts, FIFO
 *      tiebreaker on equal scores.
 *   5. Assign court letters globally (A = best court overall, descending).
 *   6. Write results to court_assignments table (upsert) and update
 *      availability records (court_letter, court_assignment_status).
 *
 * The 2-step rule (max gap ≤ 2) is an optimisation target, not a hard
 * constraint — it is never allowed to block an assignment.
 *
 * Exports:
 *   runProcedure2(sessionId)   — main entry point; resolves siblings,
 *                                runs algorithm, writes results
 *
 * References:
 *   Phase 2 Section 4.5 — Procedure 2 (Final Court Assignment)
 *   Phase 2 Section 5    — Session Roster Condition
 *   Phase 3 Group 5      — Time-based triggers crossing lifecycles
 *   Automation Logic Section 8 — Court Assignment Workflow
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSkill, scoreCourts, combinations } from '@/lib/court-balancing'

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Runs Procedure 2 (Final Court Assignment) for a session.
 *
 * Accepts any sessionId belonging to the target day — on multi-location
 * days, sibling sessions are resolved automatically from the week_id and
 * session_date of the given session.
 *
 * @param {string|number} sessionId  — ID of any session for the target day
 * @returns {Promise<Procedure2Result>}
 *
 * @typedef {object} Procedure2Result
 * @property {boolean}  success
 * @property {string}   [error]          — set on failure
 * @property {object[]} courts           — array of court objects (see below)
 * @property {number}   confirmedCount   — players on complete courts
 * @property {number}   tentativeCount   — players on incomplete courts
 * @property {number}   subsNeeded       — players needed to complete courts
 * @property {boolean}  isMultiLocation  — true if multiple sessions on day
 * @property {object[]} sessions         — all session records for the day
 *
 * Court object:
 * @typedef {object} CourtResult
 * @property {string}   courtLetter      — 'A', 'B', 'C', ...
 * @property {string}   locationName
 * @property {number}   locationId
 * @property {number}   sessionId        — session this court belongs to
 * @property {boolean}  isComplete       — true if court has exactly 4 players
 * @property {object[]} players          — players on this court
 */
export async function runProcedure2(sessionId) {
  // ------------------------------------------------------------------
  // Step 1: Fetch the anchor session to get week_id and session_date.
  // ------------------------------------------------------------------
  const { data: anchorSession, error: anchorError } = await supabaseAdmin
    .from('sessions')
    .select('id, week_id, session_date, courts_available, location_id, locations(id, name)')
    .eq('id', sessionId)
    .single()

  if (anchorError || !anchorSession) {
    return { success: false, error: `Session ${sessionId} not found: ${anchorError?.message}` }
  }

  // ------------------------------------------------------------------
  // Step 2: Fetch all sessions for this day (multi-location support).
  // Order by courts_available desc so the largest location gets the
  // highest-skill players. Name asc as tiebreaker for determinism.
  // ------------------------------------------------------------------
  const { data: daySessions, error: daySessionsError } = await supabaseAdmin
    .from('sessions')
    .select('id, courts_available, location_id, locations(id, name)')
    .eq('week_id', anchorSession.week_id)
    .eq('session_date', anchorSession.session_date)
    .eq('status', 'closed')
    .is('cancelled_at', null)
    .order('courts_available', { ascending: false })

  if (daySessionsError || !daySessions?.length) {
    return { success: false, error: `Could not fetch day sessions: ${daySessionsError?.message}` }
  }

  const isMultiLocation = daySessions.length > 1
  const sessionIds = daySessions.map((s) => s.id)

  // ------------------------------------------------------------------
  // Step 3: Fetch all active availability records across all sessions
  // for this day (confirmed + tentative).
  // ------------------------------------------------------------------
  const { data: availRecords, error: availError } = await supabaseAdmin
    .from('availability')
    .select(`
      id,
      session_id,
      player_id,
      status,
      created_at,
      players (
        id,
        first_name,
        last_name,
        email,
        signup_token,
        skill_admin,
        skill_self
      )
    `)
    .in('session_id', sessionIds)
    .in('status', ['confirmed', 'tentative'])

  if (availError) {
    return { success: false, error: `Could not fetch availability: ${availError.message}` }
  }

  if (!availRecords?.length) {
    return { success: false, error: 'No active players found for this session day.' }
  }

  // ------------------------------------------------------------------
  // Step 4: Build unified player pool with resolved skills.
  // Deduplicate by player_id — a player should only appear once even
  // if they somehow have records across multiple sessions (defensive).
  // ------------------------------------------------------------------
  const seenPlayerIds = new Set()
  const playerPool = []

  for (const avail of availRecords) {
    if (seenPlayerIds.has(avail.player_id)) continue
    seenPlayerIds.add(avail.player_id)

    playerPool.push({
      availabilityId: avail.id,
      playerId: avail.player_id,
      sessionId: avail.session_id,
      firstName: avail.players.first_name,
      lastName: avail.players.last_name,
      email: avail.players.email,
      signupToken: avail.players.signup_token,
      createdAt: avail.created_at,
      skill: resolveSkill(avail.players),
      status: avail.status,
    })
  }

  // Sort by skill descending, FIFO within equal skill — consistent
  // entry point for all subsequent operations.
  playerPool.sort((a, b) => {
    if (b.skill !== a.skill) return b.skill - a.skill
    return new Date(a.createdAt) - new Date(b.createdAt)
  })

  // ------------------------------------------------------------------
  // Step 5: Assign players to locations by skill band.
  //
  // Locations are already ordered by courts_available desc (Step 2),
  // so the highest-capacity location gets the highest-skill players.
  // Each location fills its capacity (courts_available * 4) before
  // moving to the next. Remaining players (incomplete court) are
  // assigned to the location with the most remaining capacity.
  // ------------------------------------------------------------------
  const locationAssignments = assignPlayersToLocations(playerPool, daySessions)

  // ------------------------------------------------------------------
  // Step 6: Within each location, balance courts using Procedure 1's
  // algorithm (minimise max skill gap, FIFO tiebreaker).
  // Assign court letters globally (A = best complete court overall).
  // ------------------------------------------------------------------
  const { courts, globalLetterCounter } = buildCourts(locationAssignments, daySessions)

  // ------------------------------------------------------------------
  // Step 7: Derive summary counts.
  // ------------------------------------------------------------------
  const completeCourts = courts.filter((c) => c.isComplete)
  const incompleteCourts = courts.filter((c) => !c.isComplete)
  const confirmedCount = completeCourts.reduce((sum, c) => sum + c.players.length, 0)
  const tentativeCount = incompleteCourts.reduce((sum, c) => sum + c.players.length, 0)
  const subsNeeded = tentativeCount === 0
    ? 0
    : (4 - (tentativeCount % 4)) % 4 || 4

  // ------------------------------------------------------------------
  // Step 8: Write results to the database.
  // ------------------------------------------------------------------
  const writeError = await writeAssignments(courts, daySessions)
  if (writeError) {
    return { success: false, error: writeError }
  }

  return {
    success: true,
    courts,
    confirmedCount,
    tentativeCount,
    subsNeeded,
    isMultiLocation,
    sessions: daySessions,
  }
}

// ---------------------------------------------------------------------------
// Location assignment
// ---------------------------------------------------------------------------

/**
 * Distributes players across locations by skill band.
 *
 * Locations are processed in order (already sorted by courts_available desc).
 * Each location claims the next (courts_available * 4) players from the
 * skill-sorted pool. Any remaining players go to the last location.
 *
 * @param {object[]} playerPool   — skill-sorted (desc) player objects
 * @param {object[]} daySessions  — session records sorted by courts_available desc
 * @returns {Map<number, object[]>}  locationId → players array
 */
function assignPlayersToLocations(playerPool, daySessions) {
  const locationMap = new Map() // locationId → players[]
  let offset = 0

  for (let i = 0; i < daySessions.length; i++) {
    const session = daySessions[i]
    const locationId = session.location_id
    const isLast = i === daySessions.length - 1

    if (!locationMap.has(locationId)) {
      locationMap.set(locationId, [])
    }

    const capacity = session.courts_available * 4
    // Last location gets all remaining players (handles incomplete courts).
    const slice = isLast
      ? playerPool.slice(offset)
      : playerPool.slice(offset, offset + capacity)

    locationMap.get(locationId).push(...slice)
    offset += isLast ? playerPool.length - offset : capacity

    if (offset >= playerPool.length) break
  }

  return locationMap
}

// ---------------------------------------------------------------------------
// Court building and letter assignment
// ---------------------------------------------------------------------------

/**
 * Builds balanced courts within each location and assigns global court letters.
 *
 * Court letters are assigned globally: A = the best-balanced complete court
 * across all locations (lowest max skill gap, then highest average skill,
 * then FIFO). This means Court A may be at Location 1 and Court B also at
 * Location 1 if that location has more courts than Location 2.
 *
 * Incomplete courts are assigned letters after all complete courts.
 *
 * @param {Map<number, object[]>} locationAssignments  locationId → players[]
 * @param {object[]} daySessions
 * @returns {{ courts: CourtResult[], globalLetterCounter: number }}
 */
function buildCourts(locationAssignments, daySessions) {
  // Build a lookup from locationId → session record.
  const sessionByLocationId = new Map(
    daySessions.map((s) => [s.location_id, s])
  )

  const completeCourtsRaw = []  // fully-formed courts (4 players)
  const incompleteCourtsRaw = [] // courts with < 4 players

  for (const [locationId, players] of locationAssignments) {
    const session = sessionByLocationId.get(locationId)
    const locationName = session?.locations?.name ?? 'TBD'
    const sessionId = session?.id

    if (!players.length) continue

    const courtsCount = Math.floor(players.length / 4)
    const remainder = players.length % 4

    if (courtsCount === 0) {
      // All players on an incomplete court — tentative.
      incompleteCourtsRaw.push({
        locationId,
        locationName,
        sessionId,
        players,
        score: Infinity,
        avgSkill: averageSkill(players),
      })
      continue
    }

    // Balance the complete court players using the same algorithm as
    // Procedure 1: enumerate combinations, pick lowest max-gap.
    const confirmedCount = courtsCount * 4
    const { bestCombo, bestScore } = findBestCombo(players, confirmedCount)

    // Split into complete courts of 4 (sorted by skill desc within combo).
    const sortedCombo = [...bestCombo].sort((a, b) => b.skill - a.skill)
    for (let i = 0; i < sortedCombo.length; i += 4) {
      const courtPlayers = sortedCombo.slice(i, i + 4)
      completeCourtsRaw.push({
        locationId,
        locationName,
        sessionId,
        players: courtPlayers,
        score: scoreCourts(courtPlayers),
        avgSkill: averageSkill(courtPlayers),
      })
    }

    // Remaining players (incomplete court) — tentative.
    if (remainder > 0) {
      const tentativePlayers = players.filter(
        (p) => !bestCombo.find((c) => c.availabilityId === p.availabilityId)
      )
      incompleteCourtsRaw.push({
        locationId,
        locationName,
        sessionId,
        players: tentativePlayers,
        score: Infinity,
        avgSkill: averageSkill(tentativePlayers),
      })
    }
  }

  // ------------------------------------------------------------------
  // Sort complete courts for letter assignment:
  //   Primary: lowest score (best balance)
  //   Secondary: highest avgSkill (Court A = top level)
  //   Tertiary: earliest FIFO of first player (determinism)
  // ------------------------------------------------------------------
  completeCourtsRaw.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (b.avgSkill !== a.avgSkill) return b.avgSkill - a.avgSkill
    const aEarliest = Math.min(...a.players.map((p) => new Date(p.createdAt).getTime()))
    const bEarliest = Math.min(...b.players.map((p) => new Date(p.createdAt).getTime()))
    return aEarliest - bEarliest
  })

  // Assign letters: complete courts first (A, B, C...), then incomplete.
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let letterIndex = 0

  const courts = []

  for (const court of completeCourtsRaw) {
    courts.push({
      courtLetter: LETTERS[letterIndex++] ?? `Court${letterIndex}`,
      locationId: court.locationId,
      locationName: court.locationName,
      sessionId: court.sessionId,
      isComplete: true,
      players: court.players,
    })
  }

  for (const court of incompleteCourtsRaw) {
    courts.push({
      courtLetter: LETTERS[letterIndex++] ?? `Court${letterIndex}`,
      locationId: court.locationId,
      locationName: court.locationName,
      sessionId: court.sessionId,
      isComplete: false,
      players: court.players,
    })
  }

  return { courts, globalLetterCounter: letterIndex }
}

// ---------------------------------------------------------------------------
// Database writes
// ---------------------------------------------------------------------------

/**
 * Writes Procedure 2 results to court_assignments and availability tables.
 *
 * court_assignments: upsert one row per player per session
 *   (unique constraint: player_id + session_id).
 *
 * availability: update court_letter and court_assignment_status for each
 *   player. Confirmed players (complete courts) get status 'confirmed'.
 *   Tentative players (incomplete courts) get status 'tentative'.
 *
 * @param {CourtResult[]} courts
 * @param {object[]} daySessions
 * @returns {Promise<string|null>}  error message or null on success
 */
async function writeAssignments(courts, daySessions) {
  // Build upsert payloads for court_assignments.
  const courtAssignmentRows = []
  const availabilityUpdates = [] // { availabilityId, courtLetter, status }

  for (const court of courts) {
    for (const player of court.players) {
      courtAssignmentRows.push({
        session_id: court.sessionId,
        player_id: player.playerId,
        location_id: court.locationId,
        court_number: null,          // organiser fills this in at print time
        assignment_status: court.isComplete ? 'confirmed' : 'tentative',
        // court_letter stored on availability, not court_assignments
        // (court_assignments.court_number is the real-world number field)
        updated_at: new Date().toISOString(),
      })

      availabilityUpdates.push({
        availabilityId: player.availabilityId,
        courtLetter: court.courtLetter,
        status: court.isComplete ? 'confirmed' : 'tentative',
      })
    }
  }

  // Upsert court_assignments (player_id + session_id unique constraint).
  if (courtAssignmentRows.length > 0) {
    const { error: caError } = await supabaseAdmin
      .from('court_assignments')
      .upsert(courtAssignmentRows, {
        onConflict: 'player_id,session_id',
        ignoreDuplicates: false,
      })

    if (caError) {
      return `court_assignments upsert failed: ${caError.message}`
    }
  }

  // Update availability records — court_letter and court_assignment_status.
  // Supabase doesn't support batch updates by different IDs in one call,
  // so we update in two passes: confirmed and tentative (same values within
  // each group except the ID list differs).
  //
  // For court_letter, each court has a distinct letter so we must update
  // per-court rather than per-status. Group by court letter.
  const byLetter = new Map()
  for (const update of availabilityUpdates) {
    if (!byLetter.has(update.courtLetter)) {
      byLetter.set(update.courtLetter, { ids: [], status: update.status })
    }
    byLetter.get(update.courtLetter).ids.push(update.availabilityId)
  }

  for (const [courtLetter, { ids, status }] of byLetter) {
    const { error: availError } = await supabaseAdmin
      .from('availability')
      .update({
        court_letter: courtLetter,
        court_assignment_status: status,
      })
      .in('id', ids)

    if (availError) {
      return `availability update failed for court ${courtLetter}: ${availError.message}`
    }
  }

  return null // success
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Finds the best subset of `confirmedCount` players from `players` using
 * the same algorithm as Procedure 1: minimise max skill gap, FIFO tiebreaker.
 *
 * @param {object[]} players
 * @param {number} confirmedCount
 * @returns {{ bestCombo: object[], bestScore: number }}
 */
function findBestCombo(players, confirmedCount) {
  const allCombos = combinations(players, confirmedCount)

  let bestScore = Infinity
  let bestCombo = null

  for (const combo of allCombos) {
    const score = scoreCourts(combo)

    if (score < bestScore) {
      bestScore = score
      bestCombo = combo
    } else if (score === bestScore && bestCombo !== null) {
      // FIFO tiebreaker: prefer the combo that keeps earlier signers confirmed.
      const currentExcluded = players.filter(
        (p) => !combo.find((c) => c.availabilityId === p.availabilityId)
      )
      const bestExcluded = players.filter(
        (p) => !bestCombo.find((c) => c.availabilityId === p.availabilityId)
      )
      const currentMinIdx = Math.min(...currentExcluded.map((p) => players.indexOf(p)))
      const bestMinIdx = Math.min(...bestExcluded.map((p) => players.indexOf(p)))
      if (currentMinIdx > bestMinIdx) {
        bestCombo = combo
      }
    }
  }

  return { bestCombo: bestCombo ?? players.slice(0, confirmedCount), bestScore }
}

/**
 * Returns the average skill level of a group of players.
 * Used for court letter ordering (Court A = highest avg skill).
 *
 * @param {object[]} players
 * @returns {number}
 */
function averageSkill(players) {
  if (!players.length) return 0
  return players.reduce((sum, p) => sum + p.skill, 0) / players.length
}
