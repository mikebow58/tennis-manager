/**
 * lib/court-balancing.js
 *
 * Shared court balancing logic used by:
 *   - app/api/cron/daily-8am/route.js (Procedure 1 at reminder send time)
 *   - lib/sub-requests.js (post-close promotion logic)
 *
 * Exports:
 *   runProcedure1(players)        — full initial court balancing
 *   findBestPromotion(cancelledPlayer, confirmedPlayers, tentativePlayers)
 *                                 — find best tentative player to promote
 *                                   after a post-close confirmed cancellation
 *
 * References:
 *   Phase 2 Section 4.4 — Procedure 1 (Initial Court Balancing)
 *   Phase 2 Section 4.5 — Procedure 2 (Final Court Assignment)
 */

// ---------------------------------------------------------------------------
// Skill level mapping
// ---------------------------------------------------------------------------

/**
 * Maps self-reported skill (1–5) to the admin 8-point scale.
 * Used when skill_admin is not set on a player record.
 * 1→1, 2→2, 3→4, 4→6, 5→8 (approximate NTRP equivalents).
 */
export const SKILL_SELF_TO_ADMIN = { 1: 1, 2: 2, 3: 4, 4: 6, 5: 8 }

/**
 * Resolves a player's effective skill level.
 * skill_admin is authoritative when present; falls back to mapped
 * skill_self; defaults to 4 (mid-range) if neither is set.
 *
 * @param {object} player - Raw player record from DB
 * @param {number|null} player.skill_admin
 * @param {number|null} player.skill_self
 * @returns {number} Effective skill level (1–8)
 */
export function resolveSkill(player) {
  return player.skill_admin
    ?? SKILL_SELF_TO_ADMIN[player.skill_self]
    ?? 4
}

// ---------------------------------------------------------------------------
// Core balancing utilities
// ---------------------------------------------------------------------------

/**
 * Scores a subset of players arranged into courts of 4.
 * Returns the maximum skill gap found on any single court.
 * Lower score = better balance.
 *
 * Players are sorted by skill descending before scoring to group
 * similar levels together (consistent with Procedure 1's approach).
 *
 * @param {object[]} subset - Array of player objects with .skill property
 * @returns {number} Maximum skill gap across all courts
 */
export function scoreCourts(subset) {
  const sorted = [...subset].sort((a, b) => b.skill - a.skill)
  let maxGap = 0
  for (let i = 0; i < sorted.length; i += 4) {
    const court = sorted.slice(i, i + 4)
    const gap = court[0].skill - court[court.length - 1].skill
    if (gap > maxGap) maxGap = gap
  }
  return maxGap
}

/**
 * Generates all combinations of size k from array arr.
 * Used to enumerate all possible confirmed-player subsets in Procedure 1.
 *
 * At realistic group sizes (≤ 20 players), combination counts stay
 * manageable: C(20,16) = 4845. Well within Vercel execution limits.
 *
 * @param {any[]} arr
 * @param {number} k
 * @returns {any[][]}
 */
export function combinations(arr, k) {
  if (k === 0) return [[]]
  if (arr.length < k) return []
  const [first, ...rest] = arr
  const withFirst = combinations(rest, k - 1).map((combo) => [first, ...combo])
  const withoutFirst = combinations(rest, k)
  return [...withFirst, ...withoutFirst]
}

// ---------------------------------------------------------------------------
// Procedure 1 — Initial Court Balancing
// ---------------------------------------------------------------------------

/**
 * Runs Procedure 1 (Initial Court Balancing) on a set of players.
 *
 * Takes the full roster of signed-up players (all in 'confirmed' status
 * at call time), determines the optimal split into confirmed (full courts)
 * vs tentative (incomplete court), and returns the result.
 *
 * Algorithm:
 *   1. Determine how many complete courts are possible (floor(n/4)).
 *   2. If 0 complete courts: all players are tentative.
 *   3. If perfect fill: all players are confirmed, no search needed.
 *   4. Otherwise: enumerate all combinations of (courtsCount * 4) players,
 *      score each by max skill gap, pick the best.
 *   5. FIFO (earliest createdAt) breaks ties between equally scored combos.
 *
 * The 2-step rule (max gap ≤ 2) is the optimisation target, not a hard
 * constraint — a full court with gap > 2 is always better than no court.
 *
 * @param {object[]} players - Array of player objects, each containing:
 *   { availabilityId, playerId, firstName, email, signupToken,
 *     createdAt, skill }
 *   Must be pre-sorted by createdAt ascending for FIFO to work correctly.
 *
 * @returns {{
 *   confirmedIds: Set<string>,  — availability IDs of confirmed players
 *   tentativeIds: Set<string>,  — availability IDs of tentative players
 *   bestScore: number,          — max skill gap of the winning arrangement
 *   courtsCount: number,        — number of full courts
 *   tentativeCount: number,     — number of tentative players
 * }}
 */
export function runProcedure1(players) {
  const playerCount = players.length
  const courtsCount = Math.floor(playerCount / 4)
  const confirmedCount = courtsCount * 4
  const tentativeCount = playerCount - confirmedCount

  if (courtsCount === 0) {
    // Fewer than 4 players — no complete courts possible.
    return {
      confirmedIds: new Set(),
      tentativeIds: new Set(players.map((p) => p.availabilityId)),
      bestScore: 0,
      courtsCount: 0,
      tentativeCount: playerCount,
    }
  }

  if (tentativeCount === 0) {
    // Perfect fill — all players confirmed, no balancing search needed.
    return {
      confirmedIds: new Set(players.map((p) => p.availabilityId)),
      tentativeIds: new Set(),
      bestScore: 0,
      courtsCount,
      tentativeCount: 0,
    }
  }

  // Mixed case — find the best subset of confirmedCount players.
  const allCombos = combinations(players, confirmedCount)

  let bestScore = Infinity
  let bestCombo = null

  for (const combo of allCombos) {
    const score = scoreCourts(combo)

    if (score < bestScore) {
      bestScore = score
      bestCombo = combo
    } else if (score === bestScore) {
      // Tied score — FIFO tiebreaker.
      // Prefer the combo that keeps earlier signers confirmed, i.e. the
      // combo whose excluded (tentative) players have higher indices in
      // the FIFO-sorted players array.
      const currentExcluded = players.filter(
        (p) => !combo.find((c) => c.availabilityId === p.availabilityId)
      )
      const bestExcluded = players.filter(
        (p) => !bestCombo.find((c) => c.availabilityId === p.availabilityId)
      )
      const currentMinExcludedIndex = Math.min(
        ...currentExcluded.map((p) => players.indexOf(p))
      )
      const bestMinExcludedIndex = Math.min(
        ...bestExcluded.map((p) => players.indexOf(p))
      )
      if (currentMinExcludedIndex > bestMinExcludedIndex) {
        bestCombo = combo
      }
    }
  }

  const confirmedIds = new Set(bestCombo.map((p) => p.availabilityId))
  const tentativeIds = new Set(
    players.filter((p) => !confirmedIds.has(p.availabilityId)).map((p) => p.availabilityId)
  )

  return { confirmedIds, tentativeIds, bestScore, courtsCount, tentativeCount }
}

// ---------------------------------------------------------------------------
// Post-close promotion logic
// ---------------------------------------------------------------------------

/**
 * Finds the best tentative player to promote to confirmed after a post-close
 * confirmed player cancellation.
 *
 * Uses Option 2 (skill proximity to the cancelled player) as an approximation
 * of Method 1 (skill fit to the specific court). Since court_number is not
 * populated after Procedure 1, we infer the best fit by finding the tentative
 * player whose skill level is closest to the cancelled player's skill level.
 *
 * The 2-step rule is applied as a preference (lower gap = better) but never
 * blocks a promotion. If all tentative players exceed the 2-step threshold,
 * the closest one is still promoted.
 *
 * FIFO (earliest createdAt) breaks ties between equally close tentative players.
 *
 * This can be upgraded to true Method 1 (court-specific fit) once Procedure 2
 * starts populating court_assignments with court numbers.
 *
 * @param {object} cancelledPlayer - The player who just cancelled:
 *   { availabilityId, playerId, skill, createdAt }
 * @param {object[]} tentativePlayers - Current tentative players, each:
 *   { availabilityId, playerId, firstName, email, signupToken, skill, createdAt }
 *
 * @returns {object|null} The tentative player object to promote, or null if
 *   no tentative players exist.
 */
export function findBestPromotion(cancelledPlayer, tentativePlayers) {
  if (!tentativePlayers || tentativePlayers.length === 0) return null

  // Sort tentative players by skill proximity to the cancelled player.
  // Ties in skill proximity broken by FIFO (earlier createdAt wins).
  const sorted = [...tentativePlayers].sort((a, b) => {
    const gapA = Math.abs(a.skill - cancelledPlayer.skill)
    const gapB = Math.abs(b.skill - cancelledPlayer.skill)
    if (gapA !== gapB) return gapA - gapB
    // FIFO tiebreaker: earlier signup wins.
    return new Date(a.createdAt) - new Date(b.createdAt)
  })

  return sorted[0]
}