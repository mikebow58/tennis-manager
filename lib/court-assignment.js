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
 *   6. Within each complete court, pair players into two teams of 2 using
 *      a "snake" pairing: highest skill paired with lowest skill (team 1),
 *      second-highest paired with second-lowest (team 2). This balances
 *      the two teams against each other rather than stacking skill.
 *      Incomplete courts (fewer than 4 players) and singles courts are
 *      never team-paired.
 *   7. Write results to court_assignments table (upsert) and update
 *      availability records (status, court_letter, team_number,
 *      court_assignment_status).
 *
 * The 2-step rule (max gap ≤ 2) is an optimisation target, not a hard
 * constraint — it is never allowed to block an assignment.
 *
 * Partnerships (team_number) are a "first set" starting point only — they
 * do not interact with rotation_type (keep_partners / rotate_partners)
 * logic, which governs what happens after the first set independent of
 * how the initial teams were formed.
 *
 * FIX (Sept 2 session): every player object in playerPool (and therefore
 * every downstream court.players entry) only ever carried `skill`, the
 * output of resolveSkill() — which applies the internal-only cross-gender
 * comparison adjustment (-2 steps for female players; see
 * lib/court-balancing.js). That adjustment is "never stored or displayed"
 * by codebase convention. The daily-6pm-court-assignment organiser email
 * violated that convention by rendering getSkillLabel() on the raw `skill`
 * value. Fixed by adding a second field, `displaySkill`, resolved the same
 * way `skill` is but WITHOUT the gender adjustment — the only field safe
 * to render via getSkillLabel() anywhere a human reads it.
 *
 * FIX (Sept 3 session — found live during the two-week cron load test,
 * the first day this test genuinely exercised a from-scratch rebalance of
 * a still-short session at 6pm rather than a session that was already
 * full or fully resolved before 6pm ran): writeAssignments() computed a
 * `status` value for every player ('confirmed' for complete-court players,
 * 'tentative' for incomplete-court players) but only ever wrote it into
 * the `court_assignment_status` column — the top-level `availability.status`
 * column was never updated. Procedure 2 could therefore silently move a
 * player onto or off of an incomplete court while leaving their `status`
 * field pointing at whatever it was before the rebalance.
 *
 * This produced two mirror-image failure modes, both confirmed live for
 * session 72 on Sept 3: (1) two players who were CONFIRMED before the
 * rebalance got moved onto the incomplete court, but their stale
 * status='confirmed' made them invisible to daily-8pm-backstop's
 * `.eq('status', 'tentative')` cancellation query — they received no
 * email at all, neither a confirmation nor a cancellation notice; (2) one
 * player who was TENTATIVE before the rebalance got promoted into a
 * complete court, but their stale status='tentative' caused the backstop
 * to wrongfully auto-cancel a player who had legitimately been assigned a
 * court and had already received a confirmed-details email in the same
 * run. A downstream, second-order consequence: a manual organiser add
 * made between the 6pm rebalance and the 8pm backstop used
 * app/api/admin/availability's `.eq('status', 'tentative')` count to
 * determine whether the add completed the roster — since that count was
 * already corrupted by this same desync, the add was misclassified as
 * not completing the roster when it actually did.
 *
 * This never surfaced in earlier test sessions because every prior 6pm
 * run either (a) found a session already fully filled before 6pm — via
 * claim_sub_request()'s own promotion logic, which sets status directly —
 * so Procedure 2 never needed to reclassify anyone who wasn't already
 * correctly 'confirmed', or (b) never ran the Path B rebalance branch at
 * all. Session 72 was the first case in this test where Procedure 2
 * genuinely rebalanced a still-short roster from scratch, which is
 * exactly the scenario this bug required to manifest.
 *
 * Fixed by writing `status` alongside `court_assignment_status` in the
 * same update call — both columns now always reflect Procedure 2's
 * current determination for every player it touches. Safe unconditionally:
 * Procedure 2's player pool is fetched with
 * `.in('status', ['confirmed', 'tentative'])` (Step 3 below), so it never
 * includes cancelled, declined, or waitlisted players — there is no risk
 * of this write clobbering a status value Procedure 2 shouldn't touch.
 *
 * Manual DB correction required for session 72's three affected players
 * (Maria Brown, Susan Williams, David Lewis) — handled by hand outside
 * this fix, per Mikel's decision. David Lewis also received an incorrect
 * cancellation-notice email tonight that cannot be unsent — flagged
 * separately for an out-of-band correction with him directly.
 *
 * References:
 *   Phase 2 Section 4.5 — Procedure 2 (Final Court Assignment)
 *   Phase 2 Section 5    — Session Roster Condition
 *   Phase 3 Group 5      — Time-based triggers crossing lifecycles
 *   Automation Logic Section 8 — Court Assignment Workflow
 *   lib/court-balancing.js — resolveSkill() gender adjustment, "internal
 *     only, never stored or displayed" convention
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSkill, scoreCourts, combinations, SKILL_SELF_TO_ADMIN } from '@/lib/court-balancing'

// ---------------------------------------------------------------------------
// Display skill resolution (no gender adjustment — see FIX note above)
// ---------------------------------------------------------------------------

/**
 * Resolves a player's admin-scale skill level for DISPLAY purposes only —
 * skill_admin if set, otherwise skill_self mapped via SKILL_SELF_TO_ADMIN,
 * otherwise a default of 4. Deliberately does NOT apply the cross-gender
 * comparison adjustment that resolveSkill() applies — that adjustment is
 * internal-only and must never reach an organiser- or player-facing label.
 * Use `skill` (resolveSkill's output) for all balancing/comparison logic;
 * use `displaySkill` (this function's output) for anything rendered to a
 * human via getSkillLabel().
 *
 * @param {object} player - { skill_admin, skill_self }
 * @returns {number}
 */
function resolveDisplaySkill(player) {
  if (player.skill_admin != null) return player.skill_admin
  if (player.skill_self != null) return SKILL_SELF_TO_ADMIN[player.skill_self] ?? 4
  return 4
}

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
 * @property {object[]} players          — players on this court. Each player
 *                                          object includes a `teamNumber`
 *                                          field (1, 2, or null) when the
 *                                          court is complete, a `skill`
 *                                          field (gender-adjusted, for
 *                                          balancing/comparison only — never
 *                                          display), and a `displaySkill`
 *                                          field (NOT gender-adjusted — the
 *                                          only one safe to pass to
 *                                          getSkillLabel() for a human-facing
 *                                          label).
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
  // for this day (confirmed + tentative). This IN clause is also why
  // the writeAssignments() status-sync fix below is always safe — this
  // pool never includes cancelled, declined, or waitlisted players.
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
        skill_self,
        gender
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
  //
  // Each player carries BOTH `skill` (gender-adjusted, for balancing/
  // comparison only) and `displaySkill` (not gender-adjusted, the only
  // field safe to render via getSkillLabel() in any player- or
  // organiser-facing output). See file header for full explanation.
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
      displaySkill: resolveDisplaySkill(avail.players),
      status: avail.status,
    })
  }

  // Sort by skill descending, FIFO within equal skill — consistent
  // entry point for all subsequent operations. Sorted by the gender-
  // adjusted `skill`, matching Procedure 1's own balancing order —
  // displaySkill is carried along for later display only and never
  // drives ordering or balancing decisions.
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
  // algorithm (minimise max skill gap, FIFO tiebreaker). Pair players
  // into teams of 2 on each complete court. Assign court letters
  // globally (A = best complete court overall).
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
// Team pairing (partnerships)
// ---------------------------------------------------------------------------

/**
 * Pairs 4 players on a complete court into two teams of 2 using a "snake"
 * pairing: highest skill paired with lowest skill (team 1), second-highest
 * paired with second-lowest (team 2). This produces two teams that are
 * balanced against each other, rather than stacking the two strongest
 * players together.
 *
 * Expects exactly 4 players, already sorted by skill descending. Returns a
 * new array (does not mutate the input) where each player object has a
 * `teamNumber` field (1 or 2) added. `skill` and `displaySkill` are
 * preserved via the spread — no explicit handling needed here.
 *
 * This pairing is a "first set" starting point only — it has no bearing on
 * rotation_type (keep_partners / rotate_partners) logic, which governs what
 * happens after the first set regardless of how teams were originally formed.
 *
 * @param {object[]} sortedFourPlayers — exactly 4 players, skill desc
 * @returns {object[]} same 4 players with teamNumber added
 */
function assignTeams(sortedFourPlayers) {
  const [p1, p2, p3, p4] = sortedFourPlayers
  return [
    { ...p1, teamNumber: 1 }, // highest skill
    { ...p2, teamNumber: 2 }, // second-highest skill
    { ...p3, teamNumber: 2 }, // second-lowest skill
    { ...p4, teamNumber: 1 }, // lowest skill
  ]
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
      // All players on an incomplete court — tentative. No team pairing.
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

    // Split into complete courts of 4 (sorted by skill desc within combo),
    // pairing each court's 4 players into two teams via snake pairing.
    const sortedCombo = [...bestCombo].sort((a, b) => b.skill - a.skill)
    for (let i = 0; i < sortedCombo.length; i += 4) {
      const courtPlayers = assignTeams(sortedCombo.slice(i, i + 4))
      completeCourtsRaw.push({
        locationId,
        locationName,
        sessionId,
        players: courtPlayers,
        score: scoreCourts(courtPlayers),
        avgSkill: averageSkill(courtPlayers),
      })
    }

    // Remaining players (incomplete court) — tentative. No team pairing.
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
 * availability: update status, court_letter, team_number, and
 *   court_assignment_status for each player. Confirmed players (complete
 *   courts) get status = 'confirmed' AND court_assignment_status =
 *   'confirmed'. Tentative players (incomplete courts) get status =
 *   'tentative' AND court_assignment_status = 'tentative', team_number
 *   null.
 *
 * FIX (Sept 3 session): the update previously wrote `status` into ONLY
 * the court_assignment_status column, leaving the top-level
 * availability.status column stuck at whatever it was before this
 * Procedure 2 run. See file header for the full explanation of the two
 * failure modes this produced (silently stranded players, wrongfully
 * auto-cancelled players) and why it took until this specific session to
 * surface. Both columns are now written from the same `status` value in
 * every case — there is exactly one source of truth for a player's
 * confirmed/tentative classification going forward, not two fields that
 * can drift apart.
 *
 * displaySkill is a computed convenience field only — not written to
 * either table.
 *
 * @param {CourtResult[]} courts
 * @param {object[]} daySessions
 * @returns {Promise<string|null>}  error message or null on success
 */
async function writeAssignments(courts, daySessions) {
  // Build upsert payloads for court_assignments.
  const courtAssignmentRows = []
  const availabilityUpdates = [] // { availabilityId, courtLetter, teamNumber, status }

  for (const court of courts) {
    for (const player of court.players) {
      courtAssignmentRows.push({
        session_id: court.sessionId,
        player_id: player.playerId,
        location_id: court.locationId,
        court_letter: court.courtLetter,
        court_number: null,          // organiser fills this in at print time
        team_number: player.teamNumber ?? null,
        assignment_status: court.isComplete ? 'confirmed' : 'tentative',
        updated_at: new Date().toISOString(),
      })

      availabilityUpdates.push({
        availabilityId: player.availabilityId,
        courtLetter: court.courtLetter,
        teamNumber: player.teamNumber ?? null,
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

  // Update availability records — status, court_letter, team_number, and
  // court_assignment_status.
  //
  // Supabase doesn't support batch updates by different IDs in one call
  // with different values, so we group rows that share the SAME court
  // letter AND the SAME team number (since two players on the same court
  // can have different team_number values, court letter alone is not a
  // safe grouping key here). Every row in a group shares the same
  // `status`/`court_assignment_status` value too, since both are derived
  // from the same court.isComplete flag.
  const groupKey = (courtLetter, teamNumber) => `${courtLetter}::${teamNumber}`
  const grouped = new Map()

  for (const update of availabilityUpdates) {
    const key = groupKey(update.courtLetter, update.teamNumber)
    if (!grouped.has(key)) {
      grouped.set(key, {
        ids: [],
        courtLetter: update.courtLetter,
        teamNumber: update.teamNumber,
        status: update.status,
      })
    }
    grouped.get(key).ids.push(update.availabilityId)
  }

  for (const [, { ids, courtLetter, teamNumber, status }] of grouped) {
    const { error: availError } = await supabaseAdmin
      .from('availability')
      .update({
        // FIX (Sept 3): status is now written here, alongside
        // court_assignment_status — both columns always agree on a
        // player's current confirmed/tentative classification after any
        // Procedure 2 run. See writeAssignments()'s own header comment
        // and the file header for the full explanation.
        status: status,
        court_letter: courtLetter,
        team_number: teamNumber,
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
 * Deliberately uses the gender-adjusted `skill`, not `displaySkill` — this
 * value drives court letter ORDERING (an internal comparison), never a
 * displayed label, so it should stay consistent with the rest of the
 * balancing algorithm.
 *
 * @param {object[]} players
 * @returns {number}
 */
function averageSkill(players) {
  if (!players.length) return 0
  return players.reduce((sum, p) => sum + p.skill, 0) / players.length
}