/**
 * lib/sub-requests.js
 *
 * Shared logic for post-close cancellation handling and sub request
 * evaluation. Called by:
 *   - /api/admin/availability (organiser removes a player post-close)
 *   - /api/cancel (player cancels their own spot post-close)
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
 * Player targeting for broadcasts (skill level, First Call, unavailable days)
 * is not yet built. The broadcast step inserts a sub_requests record and
 * sends a placeholder organiser notification. This stub will be replaced
 * when lib/targeting.js is built.
 *
 * The waitlist-first check (Phase 3 Group 2) is not yet implemented —
 * the waitlist feature is not yet built. Marked clearly below.
 *
 * References:
 *   Phase 2 Section 6 — sub_requests.status state machine
 *   Phase 2 Section 7.2 — confirmed → cancelled, tentative → cancelled
 *   Phase 3 Group 2 — availability state changes → sub request consequences
 *   Automation Logic Section 12 — cancellation and sub request logic
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSkill, findBestPromotion } from '@/lib/court-balancing'
import {
  sendPostCloseCancellationAlert,
  sendSubRequestBroadcastStub,
  sendTentativePromotedToConfirmed,
} from '@/lib/email'

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

  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) {
    console.error('[sub-requests] ADMIN_EMAIL not set — cannot send alerts')
  }

  // ------------------------------------------------------------------
  // Step 1: Fetch current active players on this session.
  // We need confirmed and tentative players separately.
  // Cancelled player's record is already updated before this runs.
  // Players sorted by created_at ascending for FIFO tiebreaker.
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // Step 2: Determine which case applies and handle internal transitions.
  //
  // Case D check first — if total active is now divisible by 4, the
  // cancellation has resolved the session to perfectly filled courts.
  // This takes priority over the other cases.
  // ------------------------------------------------------------------

  const sessionDateLabel = session.session_date
    ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })
    : 'Unknown date'
  const locationName = session.locations?.name ?? 'TBD'
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

  // ----------------------------------------------------------------
  // CASE D — Cancellation results in perfectly filled courts.
  // Total active players is now divisible by 4.
  // Promote all remaining tentative players to confirmed.
  // Sub request need drops to 0 — close any active sub request.
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

      // Email each newly promoted player.
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

    // Close any active sub request for this session.
    await closeActiveSubRequest(sessionId)

    // Alert organiser.
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
      }).catch((err) => console.error('[sub-requests] Case D: alert email failed:', err))
    }

    return
  }

  // ----------------------------------------------------------------
  // CASE D (edge) — Total active is divisible by 4 but no tentative
  // players exist. This means all remaining players are confirmed and
  // the courts are complete. No action needed beyond the alert.
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
      }).catch((err) => console.error('[sub-requests] Case D edge: alert email failed:', err))
    }

    return
  }

  // ----------------------------------------------------------------
  // CASE C — Confirmed player cancelled from a perfectly full session
  // (no tentative players existed before this cancellation).
  // Silently demote the 3 remaining players on the broken court.
  // No notification sent to demoted players.
  // ----------------------------------------------------------------
  if (cancelledPlayerStatus === 'confirmed' && tentativePlayers.length === 0) {
    console.log(
      `[sub-requests] Case C: confirmed player cancelled from a full session. ` +
      `Identifying 3 court-mates to silently demote to tentative.`
    )

    // Find the 3 confirmed players whose skill is closest to the cancelled
    // player's skill. We need the cancelled player's skill for this — fetch it.
    const { data: cancelledAvail, error: cancelledFetchError } = await supabaseAdmin
      .from('availability')
      .select(`players ( skill_admin, skill_self )`)
      .eq('session_id', sessionId)
      .eq('player_id', cancelledPlayerId)
      .single()

    let cancelledSkill = 4 // fallback
    if (!cancelledFetchError && cancelledAvail) {
      cancelledSkill = resolveSkill(cancelledAvail.players)
    }

    // Sort confirmed players by skill proximity to the cancelled player.
    // FIFO tiebreaker (latest signup = most recently added to the court).
    const sortedByProximity = [...confirmedPlayers].sort((a, b) => {
      const gapA = Math.abs(a.skill - cancelledSkill)
      const gapB = Math.abs(b.skill - cancelledSkill)
      if (gapA !== gapB) return gapA - gapB
      // FIFO: later signup is more likely the court-mate (signed up into
      // the same court group). Use descending createdAt for this sort.
      return new Date(b.createdAt) - new Date(a.createdAt)
    })

    // The 3 most proximate confirmed players are inferred court-mates.
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

    // subsNeeded = 1 (one player needed to complete the broken court).
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
      }).catch((err) => console.error('[sub-requests] Case C: alert email failed:', err))
    }

    await evaluateAndSendSubRequest({
      sessionId,
      subsNeeded,
      sessionDateLabel,
      locationName,
      adminEmail,
    })

    return
  }

  // ----------------------------------------------------------------
  // CASE A — Tentative player cancelled.
  // CASE B — Confirmed player cancelled, tentative players exist.
  // Both result in subsNeeded increasing by 1.
  // Case B additionally promotes the best tentative player.
  // ----------------------------------------------------------------

  let subsNeeded = 4 - (tentativePlayers.length % 4 === 0 ? 4 : tentativePlayers.length % 4)
  // Simpler: after a Case A or B cancellation, tentative count is what it is.
  // subsNeeded = players needed to complete the incomplete court(s).
  // Formula: (4 - (tentativeCount % 4)) % 4
  // But if tentativeCount % 4 === 0 that means courts are full — handled by Case D above.
  // So here tentativeCount % 4 is always non-zero.
  subsNeeded = (4 - (tentativePlayers.length % 4)) % 4
  if (subsNeeded === 0) subsNeeded = 4 // Safety: shouldn't reach here, but if tentativeCount is a multiple of 4 and we're here, something is wrong — default to 4.

  let promotionSummary = null

  if (cancelledPlayerStatus === 'confirmed' && tentativePlayers.length > 0) {
    // Case B: find the best tentative player to promote.
    console.log(`[sub-requests] Case B: confirmed player cancelled, ${tentativePlayers.length} tentative player(s) exist. Finding best promotion.`)

    // Build a minimal cancelled player object for findBestPromotion.
    // We need their skill level — fetch from the cancelled availability record.
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
    const playerToPromote = findBestPromotion(cancelledPlayerObj, tentativePlayers)

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
        // Email the promoted player.
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
    }
  } else {
    console.log(`[sub-requests] Case A: tentative player cancelled. subsNeeded=${subsNeeded}`)
  }

  // Alert organiser.
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
      confirmedPlayerNames: confirmedPlayers.map((p) => `${p.firstName} ${p.lastName}`),
      tentativePlayerNames: tentativePlayers
        .filter((p) => p.availabilityId !== playerToPromote?.availabilityId)
        .map((p) => `${p.firstName} ${p.lastName}`),
    }).catch((err) => console.error('[sub-requests] alert email failed:', err))
  }

  await evaluateAndSendSubRequest({
    sessionId,
    subsNeeded,
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
 * Staleness check: now() - sub_requests.sent_at > sub_staleness_hours.
 * Default threshold: 3 hours (from admin_settings).
 *
 * STUB: Player targeting (skill level, unavailable days, First Call list)
 * not yet implemented. Sends placeholder organiser notification instead.
 * Replace sendSubRequestBroadcastStub with real targeting send when
 * lib/targeting.js is built.
 *
 * STUB: Waitlist-first check not yet implemented. When the waitlist feature
 * is built, check waitlisted players before broadcasting to all_available.
 * Per Phase 3 Group 2: 2-hour window for Wed–Sat full-at-close sessions;
 * immediate for Mon–Tue.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {number} params.subsNeeded
 * @param {string} params.sessionDateLabel
 * @param {string} params.locationName
 * @param {string|null} params.adminEmail
 */
async function evaluateAndSendSubRequest({
  sessionId,
  subsNeeded,
  sessionDateLabel,
  locationName,
  adminEmail,
}) {
  if (subsNeeded <= 0) {
    console.log('[sub-requests] evaluateAndSendSubRequest: subsNeeded=0, no broadcast needed.')
    return
  }

  // Read staleness threshold from admin_settings.
  const { data: settingRow } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'sub_staleness_hours')
    .maybeSingle()

  const stalenessHours = settingRow?.value ? parseFloat(settingRow.value) : 3
  const stalenessMs = stalenessHours * 60 * 60 * 1000

  // Fetch the most recent sub request for this session.
  const { data: latestSubRequest } = await supabaseAdmin
    .from('sub_requests')
    .select('id, status, sent_at')
    .eq('session_id', sessionId)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let needsBroadcast = false

  if (!latestSubRequest) {
    console.log('[sub-requests] No prior sub request — broadcast needed.')
    needsBroadcast = true
  } else {
    const ageMs = Date.now() - new Date(latestSubRequest.sent_at).getTime()
    const isStale = ageMs > stalenessMs
    console.log(
      `[sub-requests] Latest sub request age: ${Math.round(ageMs / 60000)}min. ` +
      `Threshold: ${stalenessHours}h. isStale=${isStale}`
    )
    if (isStale) needsBroadcast = true
  }

  if (!needsBroadcast) {
    console.log('[sub-requests] Existing sub request is recent — no new broadcast.')
    return
  }

  // Insert new sub_requests record.
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
    console.error('[sub-requests] Failed to insert sub_requests record:', insertError?.message)
    return
  }

  console.log(`[sub-requests] sub_requests record created: id=${newSubRequest.id}`)

  // STUB: send placeholder broadcast notification to organiser.
  if (adminEmail) {
    await sendSubRequestBroadcastStub({
      adminEmail,
      sessionDateLabel,
      locationName,
      openSpots: subsNeeded,
      subRequestId: newSubRequest.id,
    }).catch((err) => console.error('[sub-requests] Broadcast stub failed:', err))
  }
}