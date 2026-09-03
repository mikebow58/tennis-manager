/**
 * lib/targeting.js
 *
 * Player targeting logic for fill-in and sub request broadcasts.
 * Used by Check A (daily_8am), daily_10am_fillin_expansion, and
 * eventually post-close sub request broadcasts (replacing the stub
 * in lib/sub-requests.js).
 *
 * Targeting sequence (per Automation Logic Section 10 and Phase 1 Section 4.5),
 * UPDATED a prior revision (post-beta item #6) to add the weekly opt-out
 * exclusion as a new Step 2, renumbering the exclusions that follow it:
 *
 * FIRST CALL BROADCAST:
 *   1. Exclude players with hard unavailability for the session day
 *   2. Exclude players who opted out of the entire week (weekly_opt_outs)
 *   3. Exclude players already signed up for the session
 *   4. Exclude players who have actively declined this session
 *   5. Exclude players whose match_type_preferences don't include the session match type
 *   6. From remaining pool, return only First Call players within skill range
 *
 * ALL-AVAILABLE BROADCAST:
 *   1. Exclude players with hard unavailability for the session day
 *   2. Exclude players who opted out of the entire week (weekly_opt_outs)
 *   3. Exclude players already signed up for the session
 *   4. Exclude players who have actively declined this session
 *   5. Return all remaining players within skill range (regardless of match type)
 *   6. If that pool is empty, expand to include non-matching match type players
 *      within skill range
 *
 * Skill range: roster average ± 2 steps on the 1–8 admin scale, capped at [1, 8].
 * Skill resolution: skill_admin if set, otherwise map skill_self via SKILL_SELF_TO_ADMIN.
 *
 * FIX (Sept 2 session — found live during the two-week cron load test):
 * matchTypeCompatible was computed as
 *   preferences.includes(sessionMatchType)
 * — a strict string comparison between sessions.match_type (stored
 * lowercase/snake_case: 'doubles', 'mixed_doubles', 'singles' — see
 * Project Summary Section 17.1) and players.match_type_preferences
 * (stored title-case with spaces: "Doubles", "Mixed Doubles", "Singles",
 * "Singles (emergency only)"). These two vocabularies never intersect
 * exactly, so the check silently returned false for every player with a
 * non-empty preferences array, for every session match type, from the
 * moment match type preferences were introduced. Only players with a
 * genuinely empty preferences array (treated as compatible with
 * everything) ever passed.
 *
 * This was masked in every caller except daily-8am's First Call broadcast
 * (Step 5.5), because daily-10am-fillin-expansion and the post-close
 * sub-request flow both fall back to allAvailableExpandedPool (which
 * ignores match type entirely) whenever allAvailablePool comes back
 * empty — which, given the bug, was effectively always. First Call has
 * no such fallback, so it was quietly reduced to "contact whichever
 * empty-preferences players happen to be in skill range," for the
 * entire duration of the test up to this point. Confirmed live: session
 * 68's First Call broadcast found exactly one recipient (Terrell Davis,
 * one of only two active players with an empty preferences array) purely
 * by chance of being in range that day; session 72's two empty-array
 * candidates both fell outside its skill range, producing zero
 * recipients and surfacing the bug.
 *
 * Fixed with an explicit match-type compatibility mapping
 * (SESSION_MATCH_TYPE_COMPATIBLE_PREFERENCES below) rather than a bare
 * case-insensitive string compare, since 'mixed_doubles' vs
 * "Mixed Doubles" differs by more than case (underscore vs space) and
 * would not be fixed by case-folding alone. A normalized-comparison
 * fallback is included for any future match_type value not yet added to
 * the mapping, so an unrecognized value degrades to a best-effort
 * comparison instead of reintroducing this same silent-exclusion bug.
 *
 * DESIGN DECISION (confirmed with Mikel, Sept 2 session): players whose
 * only listed preference is "Singles (emergency only)" ARE treated as
 * match-compatible with a session.match_type of 'singles' — folded into
 * the 'singles' entry in the mapping below, rather than being kept as a
 * fully separate, non-matching preference tier.
 *
 * References:
 *   Automation Logic Section 10 — Skill Level Targeting
 *   Automation Logic Section 6.1 — First Call list definition
 *   Phase 1 Section 4.5 Check A — pre-close fill-in logic
 *   Phase 1 Section 4.6 — daily_10am_fillin_expansion
 *   Project Summary Section 17.1 — sessions.match_type / players.match_type_preferences schema
 *   Post-beta item #6 — "I'm out this week" (weekly_opt_outs table)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSkill } from '@/lib/court-balancing'

/**
 * Returns the day-of-week string used in unavailable_days arrays.
 * Matches the format stored in players.unavailable_days.
 *
 * @param {Date} sessionDate - UTC date object for the session
 * @returns {string} e.g. 'Monday', 'Tuesday', etc.
 */
function getDayOfWeekLabel(sessionDate) {
  return sessionDate.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  })
}

/**
 * Computes the target skill range for a fill-in broadcast based on the
 * current signed-up roster. Range is roster average ± 2, capped at [1, 8].
 *
 * @param {number[]} rosterSkills - Array of resolved skill integers for signed-up players
 * @returns {{ min: number, max: number }}
 */
export function computeSkillRange(rosterSkills) {
  if (rosterSkills.length === 0) {
    // No roster data — open the full range.
    return { min: 1, max: 8 }
  }
  const avg = rosterSkills.reduce((sum, s) => sum + s, 0) / rosterSkills.length
  const rounded = Math.round(avg)
  return {
    min: Math.max(1, rounded - 2),
    max: Math.min(8, rounded + 2),
  }
}

// ------------------------------------------------------------------
// Match-type compatibility mapping — see FIX note in file header.
// Keys are sessions.match_type values (lowercase/snake_case, per
// Project Summary Section 17.1). Values are the exact
// players.match_type_preferences strings (title-case with spaces) that
// count as compatible with a session of that match type.
//
// 'singles' includes "Singles (emergency only)" per Mikel's Sept 2
// design decision — a player who only listed emergency-only singles
// availability is still contacted for a regular singles session.
// ------------------------------------------------------------------
const SESSION_MATCH_TYPE_COMPATIBLE_PREFERENCES = {
  doubles: ['Doubles'],
  mixed_doubles: ['Mixed Doubles'],
  singles: ['Singles', 'Singles (emergency only)'],
}

/**
 * Normalizes a string for fallback comparison: lowercase, letters only
 * (strips spaces, underscores, parentheses, etc). Used only when
 * sessionMatchType isn't a recognized key in
 * SESSION_MATCH_TYPE_COMPATIBLE_PREFERENCES, so an unmapped future
 * match_type value degrades to a best-effort comparison instead of
 * silently excluding every player with a non-empty preferences array
 * (the original bug this file fixes).
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeToken(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * Determines whether a player's match_type_preferences are compatible
 * with a session's match_type. An empty preferences array is always
 * treated as compatible (no stated preference = open to anything), per
 * the original targeting spec.
 *
 * @param {string[]} preferences     - player.match_type_preferences
 * @param {string} sessionMatchType  - session.match_type (e.g. 'doubles')
 * @returns {boolean}
 */
function isMatchTypeCompatible(preferences, sessionMatchType) {
  if (!preferences || preferences.length === 0) return true

  const compatibleList = SESSION_MATCH_TYPE_COMPATIBLE_PREFERENCES[sessionMatchType]

  if (compatibleList) {
    return preferences.some((p) => compatibleList.includes(p))
  }

  // Fallback for a match_type not yet present in the mapping above.
  console.warn(
    `[targeting] Unrecognized session match_type "${sessionMatchType}" — ` +
    `falling back to normalized comparison. Add it to ` +
    `SESSION_MATCH_TYPE_COMPATIBLE_PREFERENCES in lib/targeting.js.`
  )
  const normalizedSessionType = normalizeToken(sessionMatchType)
  return preferences.some((p) => {
    const normalizedPref = normalizeToken(p)
    return (
      normalizedPref.startsWith(normalizedSessionType) ||
      normalizedSessionType.startsWith(normalizedPref)
    )
  })
}

/**
 * Fetches the full eligible player pool for a fill-in or sub request broadcast.
 * Applies all hard exclusions and returns two arrays:
 *   - firstCallPool: First Call players matching session match type, within skill range
 *   - allAvailablePool: all remaining eligible players within skill range
 *   - allAvailableExpandedPool: eligible players within skill range ignoring match type
 *     (used only when allAvailablePool is empty)
 *
 * @param {object} params
 * @param {string|number} params.sessionId
 * @param {string} params.sessionDayLabel   - e.g. 'Wednesday'
 * @param {string} params.sessionMatchType  - e.g. 'doubles', 'mixed_doubles', 'singles'
 * @param {number[]} params.rosterSkills    - Resolved skill values of signed-up players
 * @returns {Promise<{
 *   firstCallPool: object[],
 *   allAvailablePool: object[],
 *   allAvailableExpandedPool: object[]
 * }>}
 */
export async function buildTargetingPool({
  sessionId,
  sessionDayLabel,
  sessionMatchType,
  rosterSkills,
}) {
  const { min: skillMin, max: skillMax } = computeSkillRange(rosterSkills)

  console.log(
    `[targeting] buildTargetingPool: sessionId=${sessionId} day=${sessionDayLabel} ` +
    `matchType=${sessionMatchType} skillRange=[${skillMin},${skillMax}]`
  )

  // ------------------------------------------------------------------
  // Resolve this session's week_id, needed to check weekly_opt_outs below.
  // Post-beta item #6 addition.
  // ------------------------------------------------------------------
  const { data: sessionRow, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .select('week_id')
    .eq('id', sessionId)
    .single()

  if (sessionError || !sessionRow) {
    console.error('[targeting] Error fetching session week_id:', sessionError?.message)
    return { firstCallPool: [], allAvailablePool: [], allAvailableExpandedPool: [] }
  }

  // ------------------------------------------------------------------
  // Fetch all active players with the fields needed for targeting.
  // ------------------------------------------------------------------
  const { data: allPlayers, error: playersError } = await supabaseAdmin
    .from('players')
    .select(`
      id,
      first_name,
      last_name,
      email,
      signup_token,
      skill_admin,
      skill_self,
      gender,
      first_call,
      unavailable_days,
      match_type_preferences
    `)
    .eq('active', true)

  if (playersError) {
    console.error('[targeting] Error fetching players:', playersError.message)
    return { firstCallPool: [], allAvailablePool: [], allAvailableExpandedPool: [] }
  }

  // ------------------------------------------------------------------
  // Fetch players who opted out of this session's whole week.
  // Post-beta item #6 addition — see weekly_opt_outs table.
  // ------------------------------------------------------------------
  const { data: optedOut, error: optedOutError } = await supabaseAdmin
    .from('weekly_opt_outs')
    .select('player_id')
    .eq('week_id', sessionRow.week_id)

  if (optedOutError) {
    console.error('[targeting] Error fetching weekly opt-outs:', optedOutError.message)
    return { firstCallPool: [], allAvailablePool: [], allAvailableExpandedPool: [] }
  }

  const optedOutIds = new Set((optedOut ?? []).map((o) => o.player_id))

  // ------------------------------------------------------------------
  // Fetch players already signed up for this session (any active status).
  // These are excluded from all targeting pools.
  // ------------------------------------------------------------------
  const { data: signedUp, error: signedUpError } = await supabaseAdmin
    .from('availability')
    .select('player_id')
    .eq('session_id', sessionId)
    .in('status', ['confirmed', 'tentative', 'waitlisted'])

  if (signedUpError) {
    console.error('[targeting] Error fetching signed-up players:', signedUpError.message)
    return { firstCallPool: [], allAvailablePool: [], allAvailableExpandedPool: [] }
  }

  const signedUpIds = new Set((signedUp ?? []).map((a) => a.player_id))

  // ------------------------------------------------------------------
  // Fetch players who have actively declined this session.
  // ------------------------------------------------------------------
  const { data: declined, error: declinedError } = await supabaseAdmin
    .from('availability')
    .select('player_id')
    .eq('session_id', sessionId)
    .eq('status', 'declined')

  if (declinedError) {
    console.error('[targeting] Error fetching declined players:', declinedError.message)
    return { firstCallPool: [], allAvailablePool: [], allAvailableExpandedPool: [] }
  }

  const declinedIds = new Set((declined ?? []).map((a) => a.player_id))

  // ------------------------------------------------------------------
  // Apply hard exclusions and build pools.
  // ------------------------------------------------------------------
  const firstCallPool = []
  const allAvailablePool = []
  const allAvailableExpandedPool = []

  for (const player of allPlayers) {
    // Exclusion 1: hard unavailability for this session day.
    const unavailable = player.unavailable_days ?? []
    if (unavailable.includes(sessionDayLabel)) continue

    // Exclusion 2: opted out of this entire week. Post-beta item #6.
    if (optedOutIds.has(player.id)) continue

    // Exclusion 3: already signed up.
    if (signedUpIds.has(player.id)) continue

    // Exclusion 4: actively declined.
    if (declinedIds.has(player.id)) continue

    const skill = resolveSkill(player)

    // Exclusion 5: outside skill range.
    // Applied to all pools — we never contact players outside the range.
    if (skill < skillMin || skill > skillMax) continue

    // Match type check — used to split allAvailablePool from expanded pool.
    // FIX (Sept 2): uses isMatchTypeCompatible() instead of a bare
    // preferences.includes(sessionMatchType) strict comparison — see file
    // header for why the strict comparison never matched.
    const preferences = player.match_type_preferences ?? []
    const matchTypeCompatible = isMatchTypeCompatible(preferences, sessionMatchType)

    // First Call pool: must be first_call AND match type compatible.
    if (player.first_call && matchTypeCompatible) {
      firstCallPool.push(buildPlayerPayload(player, skill))
    }

    // All-available pool: match type compatible (non-first-call players included).
    if (matchTypeCompatible) {
      allAvailablePool.push(buildPlayerPayload(player, skill))
    }

    // Expanded pool: everyone within skill range regardless of match type.
    // This is the last-resort pool used only when allAvailablePool is empty.
    allAvailableExpandedPool.push(buildPlayerPayload(player, skill))
  }

  console.log(
    `[targeting] Pools built: firstCall=${firstCallPool.length} ` +
    `allAvailable=${allAvailablePool.length} ` +
    `allAvailableExpanded=${allAvailableExpandedPool.length} ` +
    `(optedOut=${optedOutIds.size} excluded)`
  )

  return { firstCallPool, allAvailablePool, allAvailableExpandedPool }
}

/**
 * Builds the standard player payload object used in targeting pools.
 *
 * @param {object} player - Raw player record from Supabase
 * @param {number} skill  - Resolved skill integer
 * @returns {object}
 */
function buildPlayerPayload(player, skill) {
  return {
    playerId: player.id,
    firstName: player.first_name,
    lastName: player.last_name,
    email: player.email,
    signupToken: player.signup_token,
    skill,
    firstCall: player.first_call,
  }
}