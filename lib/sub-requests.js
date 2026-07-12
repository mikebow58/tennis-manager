/**
 * lib/sub-requests.js
 *
 * Shared logic for post-close cancellation handling and sub request
 * evaluation. Called by:
 *   - /api/admin/availability (organiser removes a player post-close)
 *   - /api/cancel (player cancels their own spot post-close)
 *   - app/api/cron/waitlist-expiry/route.js (Phase 5 — calls
 *     broadcastToAllAvailable directly)
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
 * LATE-CANCELLATION OVERRIDE (added this revision — Phase 7 of the unified
 * dynamic waitlist build sequence):
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
 * REAL TARGETING POOL WIRED IN (added this revision — also Phase 7):
 *   Prior to this revision, broadcastToAllAvailable never actually called
 *   buildTargetingPool — it only inserted a sub_requests row and fired the
 *   organiser stub, with no sub_request_recipients rows at all. This was
 *   inherited as-is from the original file and is fixed here as a
 *   prerequisite for the late-cancellation skill-suspension logic to have
 *   something real to suspend. Confirmed roster skills and the session's
 *   match_type are now fetched fresh inside broadcastToAllAvailable.
 *
 * KNOWN GAP — no real confirm/decline mechanism for any broadcast type yet
 *   (waitlist, all_available, or late_cancellation). State machine stays
 *   accurate (sub_requests / sub_request_recipients rows are now correctly
 *   populated); organiser stub notification fires; real player-facing
 *   emails with working response links are deferred to a future pass, per
 *   earlier discussion.
 *
 * References:
 *   Phase 2 Section 6 — sub_requests.status state machine
 *   Phase 2 Section 6.3 — request_type reference (see naming note above)
 *   Phase 2 Section 7.2 — confirmed → cancelled, tentative → cancelled
 *   Phase 2 Section 7.1 — availability.status = 'waitlisted' definition
 *   Phase 3 Group 2 — availability state changes → sub request consequences
 *   Automation Logic Section 10 — late cancellation targeting definition
 *   Automation Logic Section 12.5 — Mon/Tue exclusion from waitlist-first
 *   Automation Logic Section 12.6 — late cancellation escalation logic
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSkill, findBestPromotion } from '@/lib/court-balancing'
import {
  sendPostCloseCancellationAlert,
  sendSubRequestBroadcastStub,
  sendTentativePromotedToConfirmed,
} from '@/lib/email'
import { formatDeadlineTime } from '@/lib/utils'
import { getAdminEmail } from '@/lib/admin-settings'
import { buildTargetingPool } from '@/lib/targeting'

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

  const { data: activeAvailability, error: fetchError } = await supabaseAdmin
    .from('availability')
    .select(`
      id,
      status,
      player_id,
      created_at,
      players (
        id,
        first_name,
        last_name,
        email,
        skill_admin,
        skill_self,
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
      })
      .in('id', tentativeIds)

    if (promoteError) {
      console.error('[sub-requests] Case D: error promoting tentative players:', promoteError.message)
    } else {
      console.log(`[sub-requests] Case D: ${tentativeIds.length} player(s) promoted to confirmed.`)

      for (const player of tentativePlayers) {
        await sendTentativePromotedToConfirmed({
          playerFirstName: player.firstName,
          playerEmail: player.email,
          sessionDateLabel,
          locationName,
          startTime: session.start_time,
          cancelUrl: `${baseUrl}/cancel/${player.signupToken}/${sessionId}`,
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

    const { data: cancelledAvail, error: cancelledFetchError } = await supabaseAdmin
      .from('availability')
      .select(`players ( skill_admin, skill_self )`)
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

    const { data: cancelledAvail, error: cancelledFetchError } = await supabaseAdmin
      .from('availability')
      .select(`players ( skill_admin, skill_self )`)
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
        await sendTentativePromotedToConfirmed({
          playerFirstName: playerToPromote.firstName,
          playerEmail: playerToPromote.email,
          sessionDateLabel,
          locationName,
          startTime: session.start_time,
          cancelUrl: `${baseUrl}/cancel/${playerToPromote.signupToken}/${sessionId}`,
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
 * Evaluates whether a new sub request broadcast is needed and fires it
 * if so. Used by Cases A, B, and C after subsNeeded is established.
 *
 * WAITLIST-FIRST (Phase 4) is skipped when EITHER:
 *   - the session is Mon/Tue (Automation Logic Section 12.5), OR
 *   - the cancellation is late (Phase 7, this revision — Automation Logic
 *     Section 12.6). These are independent, orthogonal conditions; either
 *     alone is sufficient to skip waitlist-first.
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
      .select('id, player_id')
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

        if (adminEmail) {
          await sendSubRequestBroadcastStub({
            adminEmail,
            sessionDateLabel,
            locationName,
            openSpots: subsNeeded,
            subRequestId: newWaitlistRequest.id,
          }).catch((err) => console.error('[sub-requests] Waitlist broadcast stub failed:', err))
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
 *   - app/api/cron/waitlist-expiry/route.js (Phase 5), bypassing
 *     waitlist-first entirely when a waitlist-first broadcast's response
 *     window has elapsed unfilled.
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
    const { data: confirmedAvail } = await supabaseAdmin
      .from('availability')
      .select('players ( skill_admin, skill_self )')
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

  if (adminEmail) {
    const stubDateLabel = isLate
      ? `LATE CANCELLATION — ${sessionDateLabel}`
      : sessionDateLabel

    await sendSubRequestBroadcastStub({
      adminEmail,
      sessionDateLabel: stubDateLabel,
      locationName,
      openSpots: subsNeeded,
      subRequestId: newSubRequest.id,
    }).catch((err) => console.error('[sub-requests] broadcastToAllAvailable: broadcast stub failed:', err))
  }
}