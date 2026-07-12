/**
 * lib/sub-requests.js
 *
 * Shared logic for post-close cancellation handling and sub request
 * evaluation. Called by:
 *   - /api/admin/availability (organiser removes a player post-close)
 *   - /api/cancel (player cancels their own spot post-close)
 *   - app/api/cron/waitlist-expiry/route.js (Phase 5 — waitlist window
 *     expiry, calls broadcastToAllAvailable directly)
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
 * WAITLIST-FIRST (Phase 4 of the unified dynamic waitlist build sequence):
 *   evaluateAndSendSubRequest checks for an existing waitlist before
 *   broadcasting to all_available. Case analysis: only Case C can ever
 *   encounter a waitlist in practice — see prior revision's header comment
 *   for the full explanation. Mon/Tue sessions are excluded from
 *   waitlist-first per Automation Logic Section 12.5.
 *
 * ALL_AVAILABLE EXTRACTION (added this revision — Phase 5, waitlist window
 * expiry): the all_available broadcast logic previously lived inline at the
 * tail of evaluateAndSendSubRequest. It is now the standalone exported
 * function broadcastToAllAvailable, called both by
 * evaluateAndSendSubRequest's normal fallthrough AND directly by
 * app/api/cron/waitlist-expiry/route.js when a waitlist-first broadcast's
 * response window elapses unfilled. Calling it directly bypasses the
 * waitlist-first check entirely — necessary, since re-running
 * evaluateAndSendSubRequest at expiry time would just re-detect the same
 * (still unresolved) waitlisted players and re-broadcast to them instead of
 * expanding to all_available as intended.
 *
 * KNOWN GAP (accepted explicitly, per discussion — not a bug):
 *   Automation Logic states that after admin_settings.escalation_time (5pm
 *   day prior), urgency trumps waitlist priority — waitlist-first should be
 *   skipped entirely. That time-of-day check is NOT implemented — it's
 *   Phase 7 (late-cancellation override), not yet built.
 *
 * KNOWN GAP — no real confirm/decline mechanism for any broadcast type yet
 *   (waitlist or all_available). State machine stays accurate; organiser
 *   stub notification fires; real player-facing emails with working
 *   response links are deferred to a future pass, per discussion.
 *
 * References:
 *   Phase 2 Section 6 — sub_requests.status state machine
 *   Phase 2 Section 7.2 — confirmed → cancelled, tentative → cancelled
 *   Phase 2 Section 7.1 — availability.status = 'waitlisted' definition
 *   Phase 3 Group 2 — availability state changes → sub request consequences
 *   Phase 2 Section 6.3 — request_type reference, including 'waitlist'
 *   Automation Logic Section 12 — cancellation and sub request logic
 *   Automation Logic Section 12.5 — Mon/Tue exclusion from waitlist-first
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
 * WAITLIST-FIRST (Phase 4): before falling through to broadcastToAllAvailable,
 * checks whether this session (a) is not Mon/Tue, and (b) currently has
 * waitlisted players. If both are true, contacts the waitlist as a closed
 * group instead.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.subsNeeded
 * @param {string} params.sessionDate - raw 'YYYY-MM-DD', needed for Mon/Tue detection
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
  // WAITLIST-FIRST CHECK
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

  if (!isMonOrTue) {
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

        // Waitlist-first contact sent — expansion after the window elapses
        // is handled by app/api/cron/waitlist-expiry/route.js (Phase 5),
        // which calls broadcastToAllAvailable directly. Do not also fall
        // through here.
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
      `[sub-requests] evaluateAndSendSubRequest: session ${sessionId} is Mon/Tue — ` +
      `waitlist-first skipped per Automation Logic Section 12.5. Proceeding to all_available.`
    )
  }

  // Reached when: session is Mon/Tue, OR session has no waitlisted players,
  // OR the waitlist-first insert failed and fell through.
  await broadcastToAllAvailable({
    sessionId,
    subsNeeded,
    sessionDateLabel,
    locationName,
    adminEmail,
    stalenessMs, // reuse the already-fetched threshold rather than re-querying
  })
}

/**
 * Broadcasts to all_available, with its own staleness check against the
 * most recent sub_requests row of ANY request_type for this session (this
 * matches the pre-extraction behaviour exactly — the staleness check here
 * has never been scoped to request_type = 'all_available' specifically).
 *
 * Exported so it can be called directly by:
 *   - evaluateAndSendSubRequest's normal fallthrough (Mon/Tue, or no
 *     waitlist, or waitlist insert failure)
 *   - app/api/cron/waitlist-expiry/route.js (Phase 5), which calls this
 *     directly to bypass the waitlist-first check entirely when a
 *     waitlist-first broadcast's response window has elapsed unfilled.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.subsNeeded
 * @param {string} params.sessionDateLabel
 * @param {string} params.locationName
 * @param {string|null} params.adminEmail
 * @param {number} [params.stalenessMs] - optional pre-computed staleness
 *   threshold in ms, to avoid a redundant admin_settings query when the
 *   caller already fetched it (evaluateAndSendSubRequest does this). If
 *   omitted, fetched fresh — used when called directly by the expiry cron.
 */
export async function broadcastToAllAvailable({
  sessionId,
  subsNeeded,
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

  const { data: newSubRequest, error: insertError } = await supabaseAdmin
    .from('sub_requests')
    .insert({
      session_id: sessionId,
      sent_at: new Date().toISOString(),
      request_type: 'all_available',
      status: 'active',
    })
    .select('id')
    .single()

  if (insertError || !newSubRequest) {
    console.error('[sub-requests] broadcastToAllAvailable: failed to insert sub_requests record:', insertError?.message)
    return
  }

  console.log(`[sub-requests] broadcastToAllAvailable: sub_requests record created: id=${newSubRequest.id}`)

  if (adminEmail) {
    await sendSubRequestBroadcastStub({
      adminEmail,
      sessionDateLabel,
      locationName,
      openSpots: subsNeeded,
      subRequestId: newSubRequest.id,
    }).catch((err) => console.error('[sub-requests] broadcastToAllAvailable: broadcast stub failed:', err))
  }
}