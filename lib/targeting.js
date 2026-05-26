/**
 * lib/targeting.js
 *
 * Player targeting logic for fill-in and sub request broadcasts.
 * Used by Check A (daily_8am), daily_10am_fillin_expansion, and
 * eventually post-close sub request broadcasts (replacing the stub
 * in lib/sub-requests.js).
 *
 * Targeting sequence (per Automation Logic Section 10 and Phase 1 Section 4.5):
 *
 * FIRST CALL BROADCAST:
 *   1. Exclude players with hard unavailability for the session day
 *   2. Exclude players already signed up for the session
 *   3. Exclude players who have actively declined this session
 *   4. Exclude players whose match_type_preferences don't include the session match type
 *   5. From remaining pool, return only First Call players within skill range
 *
 * ALL-AVAILABLE BROADCAST:
 *   1. Exclude players with hard unavailability for the session day
 *   2. Exclude players already signed up for the session
 *   3. Exclude players who have actively declined this session
 *   4. Return all remaining players within skill range (regardless of match type)
 *   5. If that pool is empty, expand to include non-matching match type players
 *      within skill range
 *
 * Skill range: roster average ± 2 steps on the 1–8 admin scale, capped at [1, 8].
 * Skill resolution: skill_admin if set, otherwise map skill_self via SKILL_SELF_TO_ADMIN.
 *
 * References:
 *   Automation Logic Section 10 — Skill Level Targeting
 *   Automation Logic Section 6.1 — First Call list definition
 *   Phase 1 Section 4.5 Check A — pre-close fill-in logic
 *   Phase 1 Section 4.6 — daily_10am_fillin_expansion
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

    // Exclusion 2: already signed up.
    if (signedUpIds.has(player.id)) continue

    // Exclusion 3: actively declined.
    if (declinedIds.has(player.id)) continue

    const skill = resolveSkill(player)

    // Exclusion 4: outside skill range.
    // Applied to all pools — we never contact players outside the range.
    if (skill < skillMin || skill > skillMax) continue

    // Match type check — used to split allAvailablePool from expanded pool.
    const preferences = player.match_type_preferences ?? []
    const matchTypeCompatible = preferences.length === 0 || preferences.includes(sessionMatchType)
    // Note: if a player has no preferences set, treat as compatible.

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
    `allAvailableExpanded=${allAvailableExpandedPool.length}`
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