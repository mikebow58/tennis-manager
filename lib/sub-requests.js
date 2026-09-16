/**
 * lib/sub-requests.js
 *
 * Shared logic for post-close cancellation handling and sub request
 * evaluation. Called by:
 *   - /api/admin/availability (organiser removes a player post-close)
 *   - /api/cancel (player cancels their own spot post-close)
 *   - app/api/cron/waitlist-checkpoint/route.js (silent, once-daily-per-
 *     schedule checkpoint sweep — calls checkAllExpiredWaitlists)
 *   - app/api/cron/daily-5pm-escalation/route.js (same sweep, folded in as
 *     a backstop before its existing organiser-facing escalation email)
 *
 * The core function is handlePostCloseCancellation. It:
 *   1. Determines which case applies (A, B, C, or D — see below).
 *   2. Handles any internal status transitions (promotion, silent demotion).
 *   3. Sends appropriate emails (promotion notification, organiser alert).
 *   4. Evaluates whether a sub request broadcast is needed.
 *
 * Cases:
 *   A — Tentative player cancelled: subsNeeded increases by 1.
 *   B — Confirmed player cancelled, tentative players exist: promote best
 *       tentative player to confirmed, subsNeeded still increases by 1.
 *   C — Confirmed player cancelled, session was perfectly full (no tentative):
 *       silently demote 3 court-mates to tentative, subsNeeded = 1.
 *   D — Cancellation results in perfectly filled courts (count % 4 = 0):
 *       promote all tentative players to confirmed, subsNeeded = 0,
 *       close active sub request.
 *
 * WAITLIST-FIRST (Phase 4): evaluateAndSendSubRequest checks for an
 * existing waitlist before broadcasting to all_available. Only Case C can
 * ever encounter a waitlist in practice (see prior revisions' comments for
 * the full case analysis).
 *
 * THIS REVISION (Sept 2026 session — Player page build):
 *   Both sendTentativePromotedToConfirmed calls (Case D's promotion loop
 *   and Case B) now also pass playerPageUrl (`/signup/${signupToken}` —
 *   the permanent Player page, per organiser decision, state handoff Sept
 *   11 2026), rendered as a bookmark-style footer link by lib/email.js's
 *   shared buildFooterHtml() helper. cancelUrl at both call sites was
 *   already correct (`/cancel/${signupToken}/${sessionId}`) — no bug here,
 *   just the new link added alongside it. No other logic in this file
 *   changes.
 *
 * PRIOR REVISION (Sept 2026 session — waitlist-expiry redesign):
 *   The standalone app/api/cron/waitlist-expiry/route.js cron is retired
 *   and fully absorbed here. That route was written to run every 15-30
 *   minutes, which Vercel's Hobby tier cannot schedule (each individual
 *   cron job can only fire once per day) — it was built but never actually
 *   runnable in production. Replaced with two mechanisms, both living in
 *   this file:
 *
 *     1. EVENT-DRIVEN (expireStaleWaitlistIfNeeded, called from inside
 *        evaluateAndSendSubRequest): when a NEW cancellation arrives on a
 *        session that already has an active waitlist-first broadcast, this
 *        checks whether that broadcast's response window
 *        (WAITLIST_RESPONSE_WINDOW_HOURS, 2h — Automation Logic Section
 *        12.4) has elapsed. If so, it closes the waitlist request and
 *        expands straight to all_available/late_cancellation using this
 *        cancellation's fresh subsNeeded, bypassing the normal
 *        waitlist-first block entirely for this cycle. This reuses the
 *        exact "computed on demand at the moment of a new cancellation"
 *        pattern Phase 2 Section 6.5 already established for ordinary
 *        sub-request staleness — no new infrastructure, just a second
 *        threshold check ahead of the existing one.
 *
 *     2. SWEPT (checkAllExpiredWaitlists, exported): a session with an
 *        expired waitlist that never receives a second cancellation would
 *        have no event to trigger the check above. This function sweeps
 *        every active `waitlist` sub_requests row across all sessions and
 *        expires/expands any that are past their window. It is called
 *        from two places: a new dedicated silent cron (waitlist-checkpoint,
 *        registered four times in vercel.json at fixed daily times — the
 *        standard workaround for Hobby's once-per-day-per-job limit, since
 *        Hobby now allows up to 100 distinct cron job registrations even
 *        though each can only fire once every 24 hours), and folded into
 *        the existing daily_5pm_escalation cron as a final backstop before
 *        the 6pm hard cutoff. Neither of these emits an organiser email of
 *        its own — broadcastToAllAvailable only emails players, so this
 *        entire mechanism is silent to the organiser by construction. The
 *        organiser's visibility remains the original cancellation alert
 *        (sendPostCloseCancellationAlert) plus, if the session is still
 *        short by 5pm, the unrelated escalation email — both unchanged.
 *
 *   WAITLIST_RESPONSE_WINDOW_HOURS is a hardcoded constant, not an
 *   admin_settings value. The checkpoint cron's schedule is itself
 *   hardcoded in vercel.json (changing it already requires a code edit and
 *   redeploy), so pairing it with a database-configurable duration would
 *   let the two drift out of sync with no warning. If the window ever
 *   needs to change, it's a one-line edit alongside the checkpoint
 *   schedule change, which would already be a code change anyway.
 *
 *   BUG FIX folded in here: the retired standalone waitlist-expiry.js
 *   computed subsNeeded as (4 - (tentativeCount % 4)) % 4 — tentative
 *   count alone. This is the same recurring bug documented elsewhere in
 *   this codebase's history (the Aug 30 dashboard fix, the Sept 2
 *   daily-10am-fillin-expansion fix, and the Sept 3
 *   daily-5pm-escalation fix) — it breaks the moment a sub-request
 *   respondent is promoted straight to 'confirmed' without a full
 *   Procedure 2 rebalance, since confirmedCount is then no longer
 *   guaranteed to be a multiple of 4 on its own. checkAllExpiredWaitlists
 *   below derives subsNeeded from totalSignedUp (confirmed + tentative)
 *   % 4 instead, consistent with every other corrected call site.
 *
 * LATE-CANCELLATION OVERRIDE (Phase 7 of the unified dynamic waitlist
 * build sequence):
 *   Per Automation Logic Section 12.6 ("Late Cancellation — After 5:00pm
 *   the Day Prior... Urgency overrides all priority and targeting rules")
 *   and Section 10 ("LATE CANCELLATION: Skill level targeting suspended.
 *   Hard unavailability (Unavailable Days) still respected."), a
 *   cancellation occurring at or after admin_settings.escalation_time on
 *   the day prior to the session now:
 *     - Skips waitlist-first entirely, regardless of Mon/Tue (which
 *       already always skips it — late is now a second, independent
 *       reason to skip, orthogonal to the day-of-week rule).
 *     - Skips the sub_staleness_hours check — always broadcasts fresh,
 *       never relies on an existing recent broadcast.
 *     - Uses request_type = 'late_cancellation' (see naming note below)
 *       instead of 'all_available'.
 *     - Builds the targeting pool with an empty rosterSkills array, which
 *       causes computeSkillRange (lib/targeting.js) to return the full
 *       [1, 8] range — no code change needed in targeting.js itself.
 *       Hard unavailability (unavailable_days) is still respected, since
 *       that exclusion in buildTargetingPool is independent of skill range.
 *
 *   NAMING NOTE: Phase 2 Section 6.3 names this request_type value 'late';
 *   the master schema reference (Automation Logic Section 17.2) lists valid
 *   sub_requests.request_type values as first_call / all_available /
 *   late_cancellation — no 'late' listed. This revision uses
 *   'late_cancellation' to match the schema reference. There is no DB-level
 *   CHECK constraint on this column (confirmed from migration SQL), so
 *   either value is technically safe, but this is a real naming
 *   inconsistency between two project documents, flagged rather than
 *   silently picked.
 *
 * REAL TARGETING POOL WIRED IN (Phase 7):
 *   Prior to that revision, broadcastToAllAvailable never actually called
 *   buildTargetingPool — it only inserted a sub_requests row and fired the
 *   organiser stub, with no sub_request_recipients rows at all. This was
 *   inherited as-is from the original file and was fixed as a prerequisite
 *   for the late-cancellation skill-suspension logic to have something
 *   real to suspend. Confirmed roster skills and the session's match_type
 *   are fetched fresh inside broadcastToAllAvailable.
 *
 * RESOLVED — real confirm/decline mechanism wired in for all_available,
 *   late_cancellation, and waitlist broadcasts via sendSubRequestBroadcast()
 *   (lib/email.js) and the atomic claim_sub_request() Postgres function,
 *   called from app/api/subs/respond/route.js. sendSubRequestBroadcastStub()
 *   has no remaining callers in this file and can be retired from
 *   lib/email.js. Known remaining limitation: if subsNeeded grows while an
 *   existing sub_requests broadcast is still active (not yet stale), the
 *   same recipient list stays in effect — new cancellations don't re-run
 *   targeting against a possibly-shifted skill range. The RPC still
 *   recomputes the required count correctly either way, so no player can
 *   be under-counted; it just means a widened pool wouldn't get pulled in
 *   until this broadcast goes stale. Acceptable for now; flagged for
 *   awareness, not fixed here.
 *
 * CROSS-GENDER SKILL NORMALIZATION (August 2026):
 *   Every player select in this file that feeds resolveSkill() includes
 *   `gender`, so the fixed cross-gender comparison adjustment (see
 *   lib/court-balancing.js) is applied consistently in: the
 *   confirmed/tentative player pool built in handlePostCloseCancellation,
 *   the cancelled player's skill lookup in both Case B and Case C, and the
 *   confirmed roster skill lookup in broadcastToAllAvailable. No other
 *   logic in this file changes — the adjustment is entirely internal to
 *   resolveSkill().
 *
 * References:
 *   Phase 2 Section 6 — sub_requests.status state machine
 *   Phase 2 Section 6.3 — request_type reference (see naming note above)
 *   Phase 2 Section 6.5 — on-demand staleness evaluation pattern (the
 *     model the event-driven waitlist expiry check reuses)
 *   Phase 2 Section 7.2 — confirmed → cancelled, tentative → cancelled
 *   Phase 2 Section 7.1 — availability.status = 'waitlisted' definition
 *   Phase 3 Group 2 — availability state changes → sub request consequences
 *   Automation Logic Section 10 — late cancellation targeting definition
 *   Automation Logic Section 12.4 — waitlist-first 2hr response window
 *   Automation Logic Section 12.5 — Mon/Tue exclusion from waitlist-first
 *   Automation Logic Section 12.6 — late cancellation escalation logic
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSkill, findBestPromotion } from '@/lib/court-balancing'
import {
  sendPostCloseCancellationAlert,
  sendSubRequestBroadcast,
  sendTentativePromotedToConfirmed,
} from '@/lib/email'
import { formatDeadlineTime } from '@/lib/utils'
import { getAdminEmail } from '@/lib/admin-settings'
import { buildTargetingPool } from '@/lib/targeting'

// Hardcoded, not an admin_settings value — see file header "THIS REVISION"
// note for why. Wed–Sat only; Mon/Tue never enter waitlist-first at all
// (Automation Logic Section 12.5), so this constant is never consulted
// for those sessions.
const WAITLIST_RESPONSE_WINDOW_HOURS = 2

/**
 * Determines whether "now" (Mountain time) is at or after escalation_time
 * on the day prior to the given session date. Uses zero-padded
 * Mountain-local date+time string comparison (consistent with the pattern
 * used elsewhere in this codebase, e.g. daily-8am's toMountainDateStr) to
 * avoid manual UTC offset / DST arithmetic, rather than constructing
 * timezone-aware Date instants directly — a pattern this codebase has
 * never needed before and which introduces more risk than the string
 * comparison approach for a single threshold check.
 *
 * @param {string} sessionDate - 'YYYY-MM-DD'
 * @returns {Promise<boolean>}
 */
async function isLateCancellation(sessionDate) {
  if (!sessionDate) {
    console.warn(
      '[sub-requests] isLateCancellation: sessionDate not provided — ' +
      'cannot evaluate. Treating as NOT late (fails safe toward normal targeting).'
    )
    return false
  }

  const { data: settingRow } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'escalation_time')
    .maybeSingle()

  const escalationTime = (settingRow?.value ?? '17:00').slice(0, 5)

  function toMountainDateStr(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }

  function toMountainTimeStr(date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Denver',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
  }

  const sessionDateObj = new Date(sessionDate + 'T12:00:00Z')
  const cutoffDateObj = new Date(sessionDateObj)
  cutoffDateObj.setUTCDate(sessionDateObj.getUTCDate() - 1)
  const cutoffDateStr = toMountainDateStr(cutoffDateObj)

  const now = new Date()
  const nowDateStr = toMountainDateStr(now)
  const nowTimeStr = toMountainTimeStr(now)

  const nowCombined = `${nowDateStr} ${nowTimeStr}`
  const cutoffCombined = `${cutoffDateStr} ${escalationTime}`

  const isLate = nowCombined >= cutoffCombined

  console.log(
    `[sub-requests] isLateCancellation: now=${nowCombined} cutoff=${cutoffCombined} isLate=${isLate}`
  )

  return isLate
}

/**
 * Computes the player-facing display label for when an automated
 * sub-request broadcast stops accepting new responses: 6:00pm the day
 * before the session -- derived as court_assignment_deadline - 2h, the
 * same moment daily_6pm_court_assignment closes any still-active
 * sub_requests (Phase 2 Section 6.2 Correction C-01). This is DIFFERENT
 * from the 8pm backstop label used in sendPostCloseCancellationAlert /
 * sendCourtAssignmentReview, which tell the ORGANISER when tentative
 * players get auto-cancelled. Conflating the two (using the 8pm label in
 * player-facing broadcast copy) was a bug in an earlier revision of this
 * file -- fixed here.
 *
 * Exported so app/api/cron/daily-8am/route.js's Step 5.5 (the initial
 * short-session broadcast) can share this exact derivation rather than
 * duplicating it.
 *
 * @param {string|null} sessionDate - 'YYYY-MM-DD'. If not provided, falls
 *   back to a generic (non-dated) label rather than throwing.
 * @returns {Promise<string>} e.g. "6:00pm today", "6:00pm tomorrow",
 *   "6:00pm Wednesday"
 */
export async function computeBroadcastDeadlineLabel(sessionDate) {
  const { data: deadlineSetting } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'court_assignment_deadline')
    .maybeSingle()

  const rawDeadline = deadlineSetting?.value ?? '20:00'
  const [rawHour, rawMinute] = rawDeadline.split(':').map(Number)

  // Derive 6pm from 8pm the same way daily_6pm_court_assignment's own
  // schedule is derived (court_assignment_deadline - 2h) — see Phase 1
  // Section 3 master schedule table.
  let derivedHour = rawHour - 2
  if (derivedHour < 0) derivedHour += 24
  const derivedTimeStr = `${String(derivedHour).padStart(2, '0')}:${String(rawMinute).padStart(2, '0')}`
  const timeLabel = formatDeadlineTime(derivedTimeStr)

  if (!sessionDate) {
    console.warn(
      '[sub-requests] computeBroadcastDeadlineLabel: sessionDate not provided — ' +
      'using a generic (non-dated) label.'
    )
    return `${timeLabel} the day before your session`
  }

  function toMountainDateStr(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }

  const sessionDateObj = new Date(sessionDate + 'T12:00:00Z')
  const cutoffDateObj = new Date(sessionDateObj)
  cutoffDateObj.setUTCDate(sessionDateObj.getUTCDate() - 1)
  const cutoffStr = toMountainDateStr(cutoffDateObj)

  const now = new Date()
  const todayStr = toMountainDateStr(now)
  const tomorrowObj = new Date(now)
  tomorrowObj.setUTCDate(now.getUTCDate() + 1)
  const tomorrowStr = toMountainDateStr(tomorrowObj)

  let dayLabel
  if (cutoffStr === todayStr) {
    dayLabel = 'today'
  } else if (cutoffStr === tomorrowStr) {
    dayLabel = 'tomorrow'
  } else {
    dayLabel = cutoffDateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    })
  }

  return `${timeLabel} ${dayLabel}`
}

/**
 * Handles everything that should happen when a player is removed from a
 * closed session. The availability status transition has already been
 * written by the calling route before this function is invoked.
 *
 * This function is intentionally fire-and-forget from the calling route.
 * Errors are caught internally and logged.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.cancelledPlayerId
 * @param {string} params.cancelledPlayerName
 * @param {string} params.cancelledPlayerStatus — 'confirmed' or 'tentative'
 *   (the status the player held BEFORE cancellation)
 * @param {object} params.session — session record from availability join:
 *   { id, status, session_date, start_time, courts_available, locations: { name } }
 * @returns {Promise<void>}
 */
export async function handlePostCloseCancellation({
  sessionId,
  cancelledPlayerId,
  cancelledPlayerName,
  cancelledPlayerStatus,
  session,
}) {
  console.log(
    `[sub-requests] handlePostCloseCancellation: sessionId=${sessionId} ` +
    `player="${cancelledPlayerName}" priorStatus=${cancelledPlayerStatus}`
  )

  const adminEmail = await getAdminEmail()
  if (!adminEmail) {
    console.error('[sub-requests] ADMIN_EMAIL not set — cannot send alerts')
  }

  const { data: deadlineSetting } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'court_assignment_deadline')
    .maybeSingle()

  const rawDeadline = deadlineSetting?.value ?? '20:00'
  const deadlineLabel = formatDeadlineTime(rawDeadline)

  // gender is included here so resolveSkill() can apply the cross-gender
  // comparison adjustment (see lib/court-balancing.js) when building the
  // confirmedPlayers / tentativePlayers pools below.
  const { data: activeAvailability, error: fetchError } = await supabaseAdmin
    .from('availability')
    .select(`
      id,
      status,
      player_id,
      created_at,
      silently_demoted,
      players (
        id,
        first_name,
        last_name,
        email,
        skill_admin,
        skill_self,
        gender,
        signup_token
      )
    `)
    .eq('session_id', sessionId)
    .in('status', ['confirmed', 'tentative'])
    .order('created_at', { ascending: true })

  if (fetchError) {
    console.error('[sub-requests] Error fetching active availability:', fetchError.message)
    return
  }

  const confirmedPlayers = activeAvailability
    .filter((a) => a.status === 'confirmed')
    .map((a) => ({
      availabilityId: a.id,
      playerId: a.player_id,
      firstName: a.players.first_name,
      lastName: a.players.last_name,
      email: a.players.email,
      signupToken: a.players.signup_token,
      createdAt: a.created_at,
      skill: resolveSkill(a.players),
    }))

  const tentativePlayers = activeAvailability
    .filter((a) => a.status === 'tentative')
    .map((a) => ({
      availabilityId: a.id,
      playerId: a.player_id,
      firstName: a.players.first_name,
      lastName: a.players.last_name,
      email: a.players.email,
      signupToken: a.players.signup_token,
      createdAt: a.created_at,
      skill: resolveSkill(a.players),
      silentlyDemoted: a.silently_demoted,
    }))

  const totalActive = confirmedPlayers.length + tentativePlayers.length

  console.log(
    `[sub-requests] Active players after cancellation: ` +
    `confirmed=${confirmedPlayers.length} tentative=${tentativePlayers.length} ` +
    `total=${totalActive}`
  )

  const sessionDateLabel = session.session_date
    ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })
    : 'Unknown date'
  const locationName = session.locations?.name ?? 'TBD'
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

  // ----------------------------------------------------------------
  // CASE D — Cancellation results in perfectly filled courts.
  // ----------------------------------------------------------------
  if (totalActive > 0 && totalActive % 4 === 0 && tentativePlayers.length > 0) {
    console.log(
      `[sub-requests] Case D: totalActive=${totalActive} is divisible by 4. ` +
      `Promoting ${tentativePlayers.length} tentative player(s) to confirmed.`
    )

    const tentativeIds = tentativePlayers.map((p) => p.availabilityId)

    const { error: promoteError } = await supabaseAdmin
      .from('availability')
      .update({
        status: 'confirmed',
        court_assignment_status: 'confirmed',
        silently_demoted: false,
      })
      .in('id', tentativeIds)

    if (promoteError) {
      console.error('[sub-requests] Case D: error promoting tentative players:', promoteError.message)
    } else {
      console.log(`[sub-requests] Case D: ${tentativeIds.length} player(s) promoted to confirmed.`)

      // Players silently demoted by an earlier Case C were never told
      // their status changed -- they don't need to be told it changed
      // back either. Only email players who received the original
      // tentative-tier reminder and are aware they were ever tentative.
      //
      // THIS REVISION: playerPageUrl added alongside the already-correct
      // cancelUrl — see file header note.
      for (const player of tentativePlayers) {
        if (player.silentlyDemoted) {
          console.log(
            `[sub-requests] Case D: skipping promotion email for ${player.firstName} ` +
            `${player.lastName} — silently demoted, promoting silently in turn.`
          )
          continue
        }

        await sendTentativePromotedToConfirmed({
          playerFirstName: player.firstName,
          playerEmail: player.email,
          sessionDateLabel,
          locationName,
          startTime: session.start_time,
          cancelUrl: `${baseUrl}/cancel/${player.signupToken}/${sessionId}`,
          playerPageUrl: `${baseUrl}/signup/${player.signupToken}`,
        }).catch((err) => {
          console.error(
            `[sub-requests] Case D: failed to send promotion email to ${player.email}:`, err
          )
        })
      }
    }

    await closeActiveSubRequest(sessionId)

    if (adminEmail) {
      await sendPostCloseCancellationAlert({
        adminEmail,
        cancelledPlayerName,
        cancelledPlayerStatus,
        sessionDateLabel,
        locationName,
        confirmedCount: totalActive,
        capacity: (session.courts_available ?? 0) * 4,
        subsNeeded: 0,
        systemAction: `${tentativePlayers.length} tentative player(s) have been promoted to confirmed. The session is now perfectly filled. The sub request has been closed.`,
        confirmedPlayerNames: [
          ...confirmedPlayers.map((p) => `${p.firstName} ${p.lastName}`),
          ...tentativePlayers.map((p) => `${p.firstName} ${p.lastName}`),
        ],
        tentativePlayerNames: [],
        deadlineLabel,
      }).catch((err) => console.error('[sub-requests] Case D: alert email failed:', err))
    }

    return
  }

  // ----------------------------------------------------------------
  // CASE D (edge) — Total active is divisible by 4 but no tentative
  // players exist.
  // ----------------------------------------------------------------
  if (totalActive > 0 && totalActive % 4 === 0 && tentativePlayers.length === 0) {
    console.log(
      `[sub-requests] Case D (confirmed-only): totalActive=${totalActive} divisible by 4. ` +
      `No tentative players — no promotion needed. Closing sub request if active.`
    )

    await closeActiveSubRequest(sessionId)

    if (adminEmail) {
      await sendPostCloseCancellationAlert({
        adminEmail,
        cancelledPlayerName,
        cancelledPlayerStatus,
        sessionDateLabel,
        locationName,
        confirmedCount: confirmedPlayers.length,
        capacity: (session.courts_available ?? 0) * 4,
        subsNeeded: 0,
        systemAction: `The session now has ${totalActive} confirmed players — courts are perfectly filled. The sub request has been closed.`,
        confirmedPlayerNames: confirmedPlayers.map((p) => `${p.firstName} ${p.lastName}`),
        tentativePlayerNames: [],
        deadlineLabel,
      }).catch((err) => console.error('[sub-requests] Case D edge: alert email failed:', err))
    }

    return
  }

  // ----------------------------------------------------------------
  // CASE C — Confirmed player cancelled from a perfectly full session.
  // Only case that can ever encounter an existing waitlist.
  // ----------------------------------------------------------------
  if (cancelledPlayerStatus === 'confirmed' && tentativePlayers.length === 0) {
    console.log(
      `[sub-requests] Case C: confirmed player cancelled from a full session. ` +
      `Identifying 3 court-mates to silently demote to tentative.`
    )

    // gender included so resolveSkill() applies the cross-gender comparison
    // adjustment to the cancelled player's skill, consistent with how
    // confirmedPlayers/tentativePlayers were resolved above.
    const { data: cancelledAvail, error: cancelledFetchError } = await supabaseAdmin
      .from('availability')
      .select(`players ( skill_admin, skill_self, gender )`)
      .eq('session_id', sessionId)
      .eq('player_id', cancelledPlayerId)
      .single()

    let cancelledSkill = 4
    if (!cancelledFetchError && cancelledAvail) {
      cancelledSkill = resolveSkill(cancelledAvail.players)
    }

    const sortedByProximity = [...confirmedPlayers].sort((a, b) => {
      const gapA = Math.abs(a.skill - cancelledSkill)
      const gapB = Math.abs(b.skill - cancelledSkill)
      if (gapA !== gapB) return gapA - gapB
      return new Date(b.createdAt) - new Date(a.createdAt)
    })

    const courtMatesToDemote = sortedByProximity.slice(0, 3)
    const demoteIds = courtMatesToDemote.map((p) => p.availabilityId)

    console.log(
      `[sub-requests] Case C: demoting ${demoteIds.length} player(s) to tentative ` +
      `(silently — no player notification).`
    )

    const { error: demoteError } = await supabaseAdmin
      .from('availability')
      .update({
        status: 'tentative',
        court_assignment_status: 'tentative',
        silently_demoted: true,
      })
      .in('id', demoteIds)

    if (demoteError) {
      console.error('[sub-requests] Case C: error demoting court-mates:', demoteError.message)
    }

    const subsNeeded = 1

    if (adminEmail) {
      await sendPostCloseCancellationAlert({
        adminEmail,
        cancelledPlayerName,
        cancelledPlayerStatus,
        sessionDateLabel,
        locationName,
        confirmedCount: confirmedPlayers.length - 3,
        capacity: (session.courts_available ?? 0) * 4,
        subsNeeded,
        systemAction: `The system is looking for ${subsNeeded} sub. A broadcast will be sent to available players.`,
        confirmedPlayerNames: confirmedPlayers
          .filter((p) => !courtMatesToDemote.find((d) => d.availabilityId === p.availabilityId))
          .map((p) => `${p.firstName} ${p.lastName}`),
        tentativePlayerNames: courtMatesToDemote.map((p) => `${p.firstName} ${p.lastName}`),
        deadlineLabel,
      }).catch((err) => console.error('[sub-requests] Case C: alert email failed:', err))
    }

    await evaluateAndSendSubRequest({
      sessionId,
      subsNeeded,
      sessionDate: session.session_date,
      sessionDateLabel,
      locationName,
      adminEmail,
    })

    return
  }

  // ----------------------------------------------------------------
  // CASE A — Tentative player cancelled.
  // CASE B — Confirmed player cancelled, tentative players exist.
  // ----------------------------------------------------------------

  let subsNeeded = (4 - (tentativePlayers.length % 4)) % 4
  if (subsNeeded === 0) subsNeeded = 4

  let promotionSummary = null
  let playerToPromote = null

  if (cancelledPlayerStatus === 'confirmed' && tentativePlayers.length > 0) {
    console.log(`[sub-requests] Case B: confirmed player cancelled, ${tentativePlayers.length} tentative player(s) exist. Finding best promotion.`)

    // gender included so resolveSkill() applies the cross-gender comparison
    // adjustment to the cancelled player's skill, consistent with how
    // confirmedPlayers/tentativePlayers were resolved above.
    const { data: cancelledAvail, error: cancelledFetchError } = await supabaseAdmin
      .from('availability')
      .select(`players ( skill_admin, skill_self, gender )`)
      .eq('session_id', sessionId)
      .eq('player_id', cancelledPlayerId)
      .single()

    const cancelledSkill = (!cancelledFetchError && cancelledAvail)
      ? resolveSkill(cancelledAvail.players)
      : 4

    const cancelledPlayerObj = { skill: cancelledSkill }
    playerToPromote = findBestPromotion(cancelledPlayerObj, tentativePlayers)

    if (playerToPromote) {
      console.log(
        `[sub-requests] Case B: promoting ${playerToPromote.firstName} ` +
        `(skill=${playerToPromote.skill}) to confirmed.`
      )

      const { error: promoteError } = await supabaseAdmin
        .from('availability')
        .update({
          status: 'confirmed',
          court_assignment_status: 'confirmed',
        })
        .eq('id', playerToPromote.availabilityId)

      if (promoteError) {
        console.error('[sub-requests] Case B: error promoting player:', promoteError.message)
      } else {
        // THIS REVISION: playerPageUrl added alongside the already-correct
        // cancelUrl — see file header note.
        await sendTentativePromotedToConfirmed({
          playerFirstName: playerToPromote.firstName,
          playerEmail: playerToPromote.email,
          sessionDateLabel,
          locationName,
          startTime: session.start_time,
          cancelUrl: `${baseUrl}/cancel/${playerToPromote.signupToken}/${sessionId}`,
          playerPageUrl: `${baseUrl}/signup/${playerToPromote.signupToken}`,
        }).catch((err) => {
          console.error('[sub-requests] Case B: promotion email failed:', err)
        })

        promotionSummary = `${playerToPromote.firstName} ${playerToPromote.lastName} has been promoted from tentative to confirmed.`
      }

      const remainingTentativeCount = tentativePlayers.filter(
        (p) => p.availabilityId !== playerToPromote?.availabilityId
      ).length
      subsNeeded = (4 - (remainingTentativeCount % 4)) % 4
      if (subsNeeded === 0) subsNeeded = 4
    }
  } else {
    console.log(`[sub-requests] Case A: tentative player cancelled. subsNeeded=${subsNeeded}`)
  }

  if (adminEmail) {
    const systemAction = subsNeeded > 0
      ? `The system is looking for ${subsNeeded} sub${subsNeeded > 1 ? 's' : ''}. A broadcast will be sent to available players.`
      : `The session is now perfectly filled.`

    await sendPostCloseCancellationAlert({
      adminEmail,
      cancelledPlayerName,
      cancelledPlayerStatus,
      sessionDateLabel,
      locationName,
      confirmedCount: confirmedPlayers.length,
      capacity: (session.courts_available ?? 0) * 4,
      subsNeeded,
      systemAction,
      promotionSummary,
      confirmedPlayerNames: [
        ...confirmedPlayers.map((p) => `${p.firstName} ${p.lastName}`),
        ...(playerToPromote ? [`${playerToPromote.firstName} ${playerToPromote.lastName}`] : []),
      ],
      tentativePlayerNames: tentativePlayers
        .filter((p) => p.availabilityId !== playerToPromote?.availabilityId)
        .map((p) => `${p.firstName} ${p.lastName}`),
        deadlineLabel,
    }).catch((err) => console.error('[sub-requests] alert email failed:', err))
  }

 await evaluateAndSendSubRequest({
    sessionId,
    subsNeeded,
    sessionDate: session.session_date,
    sessionDateLabel,
    locationName,
    adminEmail,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Closes any active sub_requests records for a session.
 * Called when subsNeeded drops to 0 (Case D).
 *
 * @param {string} sessionId
 */
async function closeActiveSubRequest(sessionId) {
  const { error } = await supabaseAdmin
    .from('sub_requests')
    .update({ status: 'closed' })
    .eq('session_id', sessionId)
    .eq('status', 'active')

  if (error) {
    console.error('[sub-requests] closeActiveSubRequest error:', error.message)
  } else {
    console.log(`[sub-requests] Active sub request(s) for session ${sessionId} closed.`)
  }
}

/**
 * Checks whether a session's active `waitlist` sub_requests row (if any)
 * has exceeded WAITLIST_RESPONSE_WINDOW_HOURS. If so, closes it and
 * expands to all_available/late_cancellation via broadcastToAllAvailable,
 * using the caller-supplied subsNeeded (which must already reflect
 * current roster state — this function does not recompute it).
 *
 * Two callers, two different subsNeeded sources:
 *   - evaluateAndSendSubRequest passes the subsNeeded it was already
 *     given by handlePostCloseCancellation's case logic (event-driven —
 *     triggered by a NEW cancellation).
 *   - checkAllExpiredWaitlists (below) computes subsNeeded fresh per
 *     session from a roster query, since it has no triggering cancellation
 *     event to derive it from.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.subsNeeded
 * @param {string} params.sessionDate - 'YYYY-MM-DD'
 * @param {string} params.sessionDateLabel
 * @param {string} params.locationName
 * @param {string|null} params.adminEmail
 * @returns {Promise<boolean>} true if an active waitlist request was found
 *   and its window had elapsed (whether or not a broadcast followed —
 *   subsNeeded=0 still counts as "handled"). false if there was no active
 *   waitlist request, or one exists but is still within its window.
 */
async function expireStaleWaitlistIfNeeded({
  sessionId,
  subsNeeded,
  sessionDate,
  sessionDateLabel,
  locationName,
  adminEmail,
}) {
  const { data: activeWaitlist, error } = await supabaseAdmin
    .from('sub_requests')
    .select('id, sent_at')
    .eq('session_id', sessionId)
    .eq('request_type', 'waitlist')
    .eq('status', 'active')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(
      `[sub-requests] expireStaleWaitlistIfNeeded: error checking session ${sessionId}:`, error.message
    )
    return false
  }

  if (!activeWaitlist) {
    return false
  }

  const ageMs = Date.now() - new Date(activeWaitlist.sent_at).getTime()
  const windowMs = WAITLIST_RESPONSE_WINDOW_HOURS * 60 * 60 * 1000

  if (ageMs < windowMs) {
    console.log(
      `[sub-requests] expireStaleWaitlistIfNeeded: session ${sessionId} waitlist still within ` +
      `window (${Math.round(ageMs / 60000)}min of ${WAITLIST_RESPONSE_WINDOW_HOURS}h) — not expiring.`
    )
    return false
  }

  console.log(
    `[sub-requests] expireStaleWaitlistIfNeeded: session ${sessionId} waitlist expired ` +
    `(${Math.round(ageMs / 60000)}min elapsed) — closing and expanding. subsNeeded=${subsNeeded}`
  )

  const { error: closeError } = await supabaseAdmin
    .from('sub_requests')
    .update({ status: 'closed' })
    .eq('id', activeWaitlist.id)

  if (closeError) {
    console.error(
      `[sub-requests] expireStaleWaitlistIfNeeded: failed to close waitlist sub_request ${activeWaitlist.id}:`,
      closeError.message
    )
  }

  if (subsNeeded <= 0) {
    console.log(
      `[sub-requests] expireStaleWaitlistIfNeeded: session ${sessionId} subsNeeded=0 — ` +
      `already resolved by another path. No broadcast needed.`
    )
    return true
  }

  await broadcastToAllAvailable({
    sessionId,
    subsNeeded,
    sessionDate,
    sessionDateLabel,
    locationName,
    adminEmail,
  })

  return true
}

/**
 * Sweeps every active `waitlist` sub_requests row across all sessions and
 * expires/expands any past WAITLIST_RESPONSE_WINDOW_HOURS. This is the
 * backstop for sessions that never receive a second cancellation to
 * trigger the event-driven check inside evaluateAndSendSubRequest.
 *
 * Called from:
 *   - app/api/cron/waitlist-checkpoint/route.js (silent, four times daily)
 *   - app/api/cron/daily-5pm-escalation/route.js (silent, folded into its
 *     one existing daily firing, before the escalation email logic)
 *
 * Emits no organiser email of its own — broadcastToAllAvailable only
 * emails players. Sessions that are cancelled or missing by the time this
 * runs simply have their stale waitlist row closed with no broadcast.
 *
 * @returns {Promise<{expired: number, alreadyResolved: number, errors: number}>}
 */
export async function checkAllExpiredWaitlists() {
  const cutoffIso = new Date(Date.now() - WAITLIST_RESPONSE_WINDOW_HOURS * 60 * 60 * 1000).toISOString()

  console.log(`[sub-requests] checkAllExpiredWaitlists: sweeping for waitlist requests sent before ${cutoffIso}`)

  const { data: expiredWaitlistRequests, error: fetchError } = await supabaseAdmin
    .from('sub_requests')
    .select(`
      id,
      session_id,
      sent_at,
      sessions (
        id,
        session_date,
        cancelled_at,
        locations ( name )
      )
    `)
    .eq('request_type', 'waitlist')
    .eq('status', 'active')
    .lte('sent_at', cutoffIso)

  const outcomes = { expired: 0, alreadyResolved: 0, errors: 0 }

  if (fetchError) {
    console.error('[sub-requests] checkAllExpiredWaitlists: error fetching expired waitlist requests:', fetchError.message)
    outcomes.errors++
    return outcomes
  }

  console.log(`[sub-requests] checkAllExpiredWaitlists: found ${expiredWaitlistRequests?.length ?? 0} candidate(s).`)

  const adminEmail = await getAdminEmail()

  for (const req of expiredWaitlistRequests ?? []) {
    const session = req.sessions
    if (!session || session.cancelled_at) {
      console.log(
        `[sub-requests] checkAllExpiredWaitlists: sub_request ${req.id} — session cancelled or missing. ` +
        `Closing row, no broadcast.`
      )
      await supabaseAdmin.from('sub_requests').update({ status: 'closed' }).eq('id', req.id)
      continue
    }

    const { data: activeRows, error: activeError } = await supabaseAdmin
      .from('availability')
      .select('status')
      .eq('session_id', session.id)
      .in('status', ['confirmed', 'tentative'])

    if (activeError) {
      console.error(
        `[sub-requests] checkAllExpiredWaitlists: error fetching roster for session ${session.id}:`,
        activeError.message
      )
      outcomes.errors++
      continue
    }

    const confirmedCount = activeRows.filter((r) => r.status === 'confirmed').length
    const tentativeCount = activeRows.filter((r) => r.status === 'tentative').length
    const totalSignedUp = confirmedCount + tentativeCount
    // Derived from totalSignedUp, not tentativeCount alone — see file
    // header "BUG FIX folded in here" note.
    const subsNeeded = (4 - (totalSignedUp % 4)) % 4

    console.log(
      `[sub-requests] checkAllExpiredWaitlists: session ${session.id} — confirmed=${confirmedCount} ` +
      `tentative=${tentativeCount} totalSignedUp=${totalSignedUp} subsNeeded=${subsNeeded}`
    )

    const sessionDateLabel = session.session_date
      ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
        })
      : 'Unknown date'
    const locationName = session.locations?.name ?? 'TBD'

    const handled = await expireStaleWaitlistIfNeeded({
      sessionId: session.id,
      subsNeeded,
      sessionDate: session.session_date,
      sessionDateLabel,
      locationName,
      adminEmail,
    })

    if (handled) {
      if (subsNeeded > 0) {
        outcomes.expired++
      } else {
        outcomes.alreadyResolved++
      }
    }
  }

  console.log('[sub-requests] checkAllExpiredWaitlists: complete.', JSON.stringify(outcomes))

  return outcomes
}

/**
 * Evaluates whether a new sub request broadcast is needed and fires it
 * if so. Used by Cases A, B, and C after subsNeeded is established.
 *
 * THIS REVISION: now begins by checking whether this session already has
 * an active waitlist-first broadcast whose response window has elapsed
 * (expireStaleWaitlistIfNeeded, using this call's own fresh subsNeeded).
 * If so, that check closes the stale waitlist and expands directly to
 * all_available/late_cancellation, and this function returns immediately
 * — the normal waitlist-first block below is skipped for this cycle,
 * since the expiry check already decided the outcome. This is the
 * event-driven half of the waitlist-expiry redesign; see file header.
 *
 * WAITLIST-FIRST (Phase 4) is otherwise skipped when EITHER:
 *   - the session is Mon/Tue (Automation Logic Section 12.5), OR
 *   - the cancellation is late (Phase 7 — Automation Logic Section 12.6).
 * These are independent, orthogonal conditions; either alone is
 * sufficient to skip waitlist-first.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.subsNeeded
 * @param {string} params.sessionDate - raw 'YYYY-MM-DD', needed for Mon/Tue
 *   detection AND late-cancellation detection.
 * @param {string} params.sessionDateLabel
 * @param {string} params.locationName
 * @param {string|null} params.adminEmail
 */
async function evaluateAndSendSubRequest({
  sessionId,
  subsNeeded,
  sessionDate,
  sessionDateLabel,
  locationName,
  adminEmail,
}) {
  if (subsNeeded <= 0) {
    console.log('[sub-requests] evaluateAndSendSubRequest: subsNeeded=0, no broadcast needed.')
    return
  }

  // Event-driven waitlist expiry check — see function doc above and file
  // header "THIS REVISION" note. Must run before the waitlist-first block
  // below: without this, a still-"active" but actually-expired waitlist
  // request would otherwise just be relied upon (or re-sent to, per the
  // sub_staleness_hours check further down) rather than expanded.
  const alreadyHandled = await expireStaleWaitlistIfNeeded({
    sessionId,
    subsNeeded,
    sessionDate,
    sessionDateLabel,
    locationName,
    adminEmail,
  })
  if (alreadyHandled) {
    console.log(
      `[sub-requests] evaluateAndSendSubRequest: session ${sessionId} — expired waitlist handled ` +
      `via expiry check, skipping normal waitlist-first flow for this cycle.`
    )
    return
  }

  const { data: settingRow } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'sub_staleness_hours')
    .maybeSingle()

  const stalenessHours = settingRow?.value ? parseFloat(settingRow.value) : 3
  const stalenessMs = stalenessHours * 60 * 60 * 1000

  // ------------------------------------------------------------------
  // Determine whether waitlist-first should be skipped: Mon/Tue OR late.
  // ------------------------------------------------------------------
  let isMonOrTue = false
  if (sessionDate) {
    const dayOfWeek = new Date(sessionDate + 'T12:00:00Z').getUTCDay()
    isMonOrTue = dayOfWeek === 1 || dayOfWeek === 2
  } else {
    console.warn(
      '[sub-requests] evaluateAndSendSubRequest: sessionDate not provided — ' +
      'cannot confirm Mon/Tue exclusion. Proceeding as if eligible for waitlist-first.'
    )
  }

  const isLate = await isLateCancellation(sessionDate)
  const skipWaitlistFirst = isMonOrTue || isLate

  if (!skipWaitlistFirst) {
    const { data: waitlistPlayers, error: waitlistError } = await supabaseAdmin
      .from('availability')
      .select(`
        id,
        player_id,
        players (
          first_name,
          email,
          signup_token
        )
      `)
      .eq('session_id', sessionId)
      .eq('status', 'waitlisted')
      .order('created_at', { ascending: true })

    if (waitlistError) {
      console.error(
        '[sub-requests] evaluateAndSendSubRequest: error checking waitlist:', waitlistError.message
      )
    } else if (waitlistPlayers && waitlistPlayers.length > 0) {
      console.log(
        `[sub-requests] evaluateAndSendSubRequest: session ${sessionId} has ` +
        `${waitlistPlayers.length} waitlisted player(s). Contacting as closed group.`
      )

      const { data: latestWaitlistRequest } = await supabaseAdmin
        .from('sub_requests')
        .select('id, sent_at')
        .eq('session_id', sessionId)
        .eq('request_type', 'waitlist')
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      let needsWaitlistBroadcast = false
      if (!latestWaitlistRequest) {
        needsWaitlistBroadcast = true
      } else {
        const ageMs = Date.now() - new Date(latestWaitlistRequest.sent_at).getTime()
        needsWaitlistBroadcast = ageMs > stalenessMs
      }

      if (!needsWaitlistBroadcast) {
        console.log(
          '[sub-requests] evaluateAndSendSubRequest: existing waitlist broadcast is recent — ' +
          'relying on it, no new send.'
        )
        return
      }

      const { data: newWaitlistRequest, error: waitlistInsertError } = await supabaseAdmin
        .from('sub_requests')
        .insert({
          session_id: sessionId,
          sent_at: new Date().toISOString(),
          request_type: 'waitlist',
          status: 'active',
        })
        .select('id')
        .single()

      if (waitlistInsertError || !newWaitlistRequest) {
        console.error(
          '[sub-requests] evaluateAndSendSubRequest: failed to insert waitlist sub_requests row:',
          waitlistInsertError?.message
        )
      } else {
        console.log(
          `[sub-requests] evaluateAndSendSubRequest: waitlist sub_requests record created id=${newWaitlistRequest.id}`
        )

        const recipientRows = waitlistPlayers.map((p) => ({
          sub_request_id: newWaitlistRequest.id,
          player_id: p.player_id,
          sent_at: new Date().toISOString(),
          response: 'no_response',
        }))

        const { error: recipientsError } = await supabaseAdmin
          .from('sub_request_recipients')
          .insert(recipientRows)

        if (recipientsError) {
          console.error(
            '[sub-requests] evaluateAndSendSubRequest: error inserting waitlist recipients:',
            recipientsError.message
          )
        } else {
          console.log(
            `[sub-requests] evaluateAndSendSubRequest: ${recipientRows.length} waitlist sub_request_recipients inserted.`
          )
        }

        // Build recipient objects straight from the joined player data —
        // filter out any waitlisted player missing an email or signup_token
        // (shouldn't happen for active players, but a missing contactability
        // field shouldn't crash the whole broadcast for everyone else).
        // Field names (firstName/email/signupToken) match buildPlayerPayload's
        // convention in lib/targeting.js, so all broadcast call sites in
        // this file share one recipient shape.
        const waitlistRecipients = waitlistPlayers
          .filter((p) => p.players?.email && p.players?.signup_token)
          .map((p) => ({
            firstName: p.players.first_name,
            email: p.players.email,
            signupToken: p.players.signup_token,
          }))

        if (waitlistRecipients.length > 0) {
          const broadcastDeadlineLabel = await computeBroadcastDeadlineLabel(sessionDate)

          await sendSubRequestBroadcast(waitlistRecipients, {
            sessionDateLabel,
            locationName,
            deadlineLabel: broadcastDeadlineLabel,
            subRequestId: newWaitlistRequest.id,
          }).catch((err) => console.error('[sub-requests] Waitlist broadcast send failed:', err))
        } else {
          console.warn(
            `[sub-requests] evaluateAndSendSubRequest: waitlist pool for session ${sessionId} ` +
            `had no players with a usable email/signup_token — no broadcast sent.`
          )
        }

        return
      }
    } else {
      console.log(
        `[sub-requests] evaluateAndSendSubRequest: session ${sessionId} has no waitlisted players. ` +
        `Proceeding to all_available.`
      )
    }
  } else {
    console.log(
      `[sub-requests] evaluateAndSendSubRequest: session ${sessionId} — waitlist-first skipped ` +
      `(isMonOrTue=${isMonOrTue}, isLate=${isLate}). Proceeding to broadcastToAllAvailable.`
    )
  }

  await broadcastToAllAvailable({
    sessionId,
    subsNeeded,
    sessionDate,
    sessionDateLabel,
    locationName,
    adminEmail,
    stalenessMs,
  })
}

/**
 * Broadcasts to all_available (or, if the cancellation is late, to
 * late_cancellation — see file header). Builds a real targeting pool via
 * lib/targeting.js and inserts sub_request_recipients rows — this was
 * previously a no-op (see file header REAL TARGETING POOL WIRED IN note).
 *
 * Exported so it can be called directly by:
 *   - evaluateAndSendSubRequest's fallthrough (Mon/Tue, late, no waitlist,
 *     or waitlist insert failure)
 *   - expireStaleWaitlistIfNeeded (above), when a waitlist-first
 *     broadcast's response window has elapsed unfilled — bypassing
 *     waitlist-first entirely.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.subsNeeded
 * @param {string} params.sessionDate - raw 'YYYY-MM-DD'. Required — used
 *   both for late-cancellation detection and for deriving the day-of-week
 *   label needed by buildTargetingPool's unavailable_days exclusion.
 * @param {string} params.sessionDateLabel
 * @param {string} params.locationName
 * @param {string|null} params.adminEmail
 * @param {number} [params.stalenessMs] - optional pre-computed staleness
 *   threshold in ms. If omitted, fetched fresh.
 */
export async function broadcastToAllAvailable({
  sessionId,
  subsNeeded,
  sessionDate,
  sessionDateLabel,
  locationName,
  adminEmail,
  stalenessMs,
}) {
  let effectiveStalenessMs = stalenessMs

  if (effectiveStalenessMs === undefined) {
    const { data: settingRow } = await supabaseAdmin
      .from('admin_settings')
      .select('value')
      .eq('key', 'sub_staleness_hours')
      .maybeSingle()

    const stalenessHours = settingRow?.value ? parseFloat(settingRow.value) : 3
    effectiveStalenessMs = stalenessHours * 60 * 60 * 1000
  }

  const isLate = await isLateCancellation(sessionDate)

  if (!isLate) {
    const { data: latestSubRequest } = await supabaseAdmin
      .from('sub_requests')
      .select('id, status, sent_at')
      .eq('session_id', sessionId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let needsBroadcast = false

    if (!latestSubRequest) {
      console.log('[sub-requests] broadcastToAllAvailable: no prior sub request — broadcast needed.')
      needsBroadcast = true
    } else {
      const ageMs = Date.now() - new Date(latestSubRequest.sent_at).getTime()
      const isStale = ageMs > effectiveStalenessMs
      console.log(
        `[sub-requests] broadcastToAllAvailable: latest sub request age: ${Math.round(ageMs / 60000)}min. ` +
        `isStale=${isStale}`
      )
      if (isStale) needsBroadcast = true
    }

    if (!needsBroadcast) {
      console.log('[sub-requests] broadcastToAllAvailable: existing sub request is recent — no new broadcast.')
      return
    }
  } else {
    console.log(
      '[sub-requests] broadcastToAllAvailable: late cancellation — skipping staleness check, broadcasting fresh regardless.'
    )
  }

  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('match_type')
    .eq('id', sessionId)
    .single()

  const sessionMatchType = session?.match_type ?? 'doubles'

  let rosterSkills = []
  if (!isLate) {
    // gender included so resolveSkill() applies the cross-gender comparison
    // adjustment when computing the confirmed roster's skill average for
    // buildTargetingPool's skill range.
    const { data: confirmedAvail } = await supabaseAdmin
      .from('availability')
      .select('players ( skill_admin, skill_self, gender )')
      .eq('session_id', sessionId)
      .eq('status', 'confirmed')

    rosterSkills = (confirmedAvail ?? []).map((a) => resolveSkill(a.players))
  }

  const sessionDayLabel = sessionDate
    ? new Date(sessionDate + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', timeZone: 'UTC',
      })
    : null

  let targetPool = []
  if (sessionDayLabel) {
    const { allAvailablePool, allAvailableExpandedPool } = await buildTargetingPool({
      sessionId,
      sessionDayLabel,
      sessionMatchType,
      rosterSkills,
    })
    targetPool = allAvailablePool.length > 0 ? allAvailablePool : allAvailableExpandedPool
  } else {
    console.warn(
      '[sub-requests] broadcastToAllAvailable: sessionDate not provided — ' +
      'cannot build targeting pool (unavailable_days exclusion requires a day label). ' +
      'Proceeding with an empty pool; sub_requests row will still be created.'
    )
  }

  console.log(
    `[sub-requests] broadcastToAllAvailable: session=${sessionId} isLate=${isLate} ` +
    `targetPool size=${targetPool.length}`
  )

  const requestType = isLate ? 'late_cancellation' : 'all_available'

  const { data: newSubRequest, error: insertError } = await supabaseAdmin
    .from('sub_requests')
    .insert({
      session_id: sessionId,
      sent_at: new Date().toISOString(),
      request_type: requestType,
      status: 'active',
    })
    .select('id')
    .single()

  if (insertError || !newSubRequest) {
    console.error('[sub-requests] broadcastToAllAvailable: failed to insert sub_requests record:', insertError?.message)
    return
  }

  console.log(`[sub-requests] broadcastToAllAvailable: sub_requests record created: id=${newSubRequest.id} request_type=${requestType}`)

  if (targetPool.length > 0) {
    const recipientRows = targetPool.map((player) => ({
      sub_request_id: newSubRequest.id,
      player_id: player.playerId,
      sent_at: new Date().toISOString(),
      response: 'no_response',
    }))

    const { error: recipientsError } = await supabaseAdmin
      .from('sub_request_recipients')
      .insert(recipientRows)

    if (recipientsError) {
      console.error(
        '[sub-requests] broadcastToAllAvailable: error inserting recipients:',
        recipientsError.message
      )
    } else {
      console.log(
        `[sub-requests] broadcastToAllAvailable: ${recipientRows.length} sub_request_recipients inserted.`
      )
    }
  } else {
    console.log('[sub-requests] broadcastToAllAvailable: no eligible players in pool.')
  }

  if (targetPool.length > 0) {
    // targetPool entries already carry firstName/email/signupToken from
    // buildPlayerPayload (lib/targeting.js) — the exact shape
    // sendSubRequestBroadcast expects, no remapping needed.
    const broadcastDeadlineLabel = await computeBroadcastDeadlineLabel(sessionDate)

    await sendSubRequestBroadcast(targetPool, {
      sessionDateLabel: isLate ? `LATE CANCELLATION — ${sessionDateLabel}` : sessionDateLabel,
      locationName,
      deadlineLabel: broadcastDeadlineLabel,
      subRequestId: newSubRequest.id,
    }).catch((err) => console.error('[sub-requests] broadcastToAllAvailable: broadcast send failed:', err))
  }
  // Empty-pool case is already logged above (search: "no eligible players
  // in pool") — the organiser was already alerted of the cancellation and
  // subsNeeded via sendPostCloseCancellationAlert, so no separate email is
  // sent here when there's simply nobody left to contact.
}