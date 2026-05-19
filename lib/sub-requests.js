/**
 * lib/sub-requests.js
 *
 * Shared logic for post-close cancellation handling and sub request
 * evaluation. Called by:
 *   - /api/admin/availability (organiser removes a player post-close)
 *   - /api/availability (player cancels their own spot post-close) [not yet built]
 *   - Player portal cancel flow [not yet built]
 *
 * The core function is handlePostCloseCancellation. It:
 *   1. Sends an immediate organiser alert with cancellation context.
 *   2. Evaluates whether a sub request broadcast is needed (staleness check).
 *   3. If needed: inserts a sub_requests record and sends a broadcast.
 *
 * Player targeting for broadcasts (skill level, First Call, unavailable days)
 * is not yet built. Step 3 currently inserts the sub_requests record and
 * logs that a broadcast would fire, but sends a placeholder organiser-facing
 * summary rather than contacting players directly. This stub will be replaced
 * when lib/targeting.js is built.
 *
 * References:
 *   Phase 2 Section 6 — sub_requests.status state machine
 *   Phase 2 Section 7.2 — confirmed → cancelled transition
 *   Phase 3 Group 2 — availability state changes → sub request consequences
 *   Automation Logic Section 12 — cancellation and sub request logic
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendPostCloseCancellationAlert,
  sendSubRequestBroadcastStub,
} from '@/lib/email'

/**
 * Handles everything that should happen when a player is removed from a
 * closed session. Fires organiser alert, evaluates staleness, and creates
 * a sub request record + broadcast if needed.
 *
 * This function is intentionally fire-and-forget from the calling route —
 * the caller does not await it. Errors are caught internally and logged.
 *
 * @param {object} params
 * @param {string} params.sessionId            - UUID of the session
 * @param {string} params.cancelledPlayerId    - UUID of the player who was removed
 * @param {string} params.cancelledPlayerName  - Display name for the organiser alert
 * @param {object} params.session              - Session record (from the availability join):
 *   { id, status, session_date, start_time, courts_available, locations: { name } }
 * @returns {Promise<void>}
 */
export async function handlePostCloseCancellation({
  sessionId,
  cancelledPlayerId,
  cancelledPlayerName,
  session,
}) {
  console.log(
    `[sub-requests] handlePostCloseCancellation: sessionId=${sessionId} player="${cancelledPlayerName}"`
  )

  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) {
    console.error('[sub-requests] ADMIN_EMAIL not set — cannot send cancellation alert')
  }

  // ------------------------------------------------------------------
  // Step 1: Gather current session context for the organiser alert.
  //
  // We need: confirmed player count (post-cancellation), courts_available,
  // and the current sub_requests status for this session.
  // ------------------------------------------------------------------

  // Count currently confirmed players on this session (excluding the
  // just-cancelled player, whose record is now in 'cancelled' status).
  const { count: confirmedCount, error: countError } = await supabaseAdmin
    .from('availability')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('status', 'confirmed')

  if (countError) {
    console.error('[sub-requests] Error counting confirmed players:', countError.message)
    // Continue — we'll send the alert with partial context rather than failing silently.
  }

  // Fetch the most recent sub_requests record for this session.
  // Used for: (a) staleness check, (b) status summary in the organiser alert.
  const { data: latestSubRequest, error: subReqError } = await supabaseAdmin
    .from('sub_requests')
    .select('id, status, sent_at, request_type')
    .eq('session_id', sessionId)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle() // Returns null if no sub request has been sent yet — not an error.

  if (subReqError) {
    console.error('[sub-requests] Error fetching latest sub request:', subReqError.message)
  }

  // Format session date for display in emails.
  const sessionDateLabel = session.session_date
    ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : 'Unknown date'

  const locationName = session.locations?.name ?? 'TBD'
  const courtsAvailable = session.courts_available ?? 0
  const capacity = courtsAvailable * 4

  // Derive how many open spots exist now (post-cancellation).
  const currentConfirmed = confirmedCount ?? 0
  const openSpots = Math.max(0, capacity - currentConfirmed)

  console.log(
    `[sub-requests] Session context: confirmedCount=${currentConfirmed} ` +
    `capacity=${capacity} openSpots=${openSpots} ` +
    `latestSubRequest=${latestSubRequest ? latestSubRequest.id : 'none'}`
  )

  // ------------------------------------------------------------------
  // Step 2: Send immediate organiser alert.
  //
  // Per Phase 3 Group 2 and Automation Logic Section 12.6, every
  // organiser alert must communicate:
  //   - Who cancelled and for which session
  //   - Current confirmed count and open spots
  //   - Current sub request status
  //   - What the system is doing about it
  // ------------------------------------------------------------------
  if (adminEmail) {
    const subRequestSummary = latestSubRequest
      ? `A sub request was sent on ${new Date(latestSubRequest.sent_at).toLocaleString('en-US', {
          timeZone: 'America/Denver',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })} and is currently ${latestSubRequest.status}.`
      : 'No sub request has been sent yet for this session.'

    await sendPostCloseCancellationAlert({
      adminEmail,
      cancelledPlayerName,
      sessionDateLabel,
      locationName,
      confirmedCount: currentConfirmed,
      capacity,
      openSpots,
      subRequestSummary,
    }).catch((err) => {
      console.error('[sub-requests] Failed to send cancellation alert:', err)
    })
  }

  // ------------------------------------------------------------------
  // Step 3: Evaluate whether a new sub request broadcast is needed.
  //
  // A broadcast is needed if:
  //   (a) There are open spots on the session (session is now short), AND
  //   (b) Either no prior sub request exists, OR the most recent sub
  //       request is stale (sent_at > staleness threshold ago).
  //
  // Staleness threshold: read from admin_settings table (key: sub_staleness_hours).
  // Default: 3 hours. Per Phase 2 Section 6.5 and Automation Logic 12.2.
  //
  // Note: the waitlist-first check (Phase 3 Group 2 — session full at close
  // → check waitlist before broadcasting) is not yet implemented. The
  // waitlist feature is not yet built. This will be added when lib/targeting.js
  // and the waitlist flow are built.
  // ------------------------------------------------------------------
  if (openSpots <= 0) {
    // Session is still at capacity after the cancellation — this can happen
    // if there are waitlisted players, or if courts_available was reduced.
    // No sub request needed.
    console.log(
      `[sub-requests] No open spots (confirmedCount=${currentConfirmed} capacity=${capacity}) — no sub request needed.`
    )
    return
  }

  // Read staleness threshold from admin_settings with a 3-hour default.
  const { data: settingRow, error: settingError } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'sub_staleness_hours')
    .maybeSingle()

  if (settingError) {
    console.error('[sub-requests] Error reading sub_staleness_hours from admin_settings:', settingError.message)
  }

  // Parse the threshold value. admin_settings stores values as text.
  const stalenessHours = settingRow?.value ? parseFloat(settingRow.value) : 3
  const stalenessMs = stalenessHours * 60 * 60 * 1000

  console.log(`[sub-requests] Staleness threshold: ${stalenessHours}h`)

  // Check staleness of the most recent sub request.
  let needsBroadcast = false

  if (!latestSubRequest) {
    // No prior broadcast for this session — definitely need one.
    console.log('[sub-requests] No prior sub request — broadcast needed.')
    needsBroadcast = true
  } else {
    const sentAt = new Date(latestSubRequest.sent_at)
    const ageMs = Date.now() - sentAt.getTime()
    const isStale = ageMs > stalenessMs

    console.log(
      `[sub-requests] Latest sub request sent at ${sentAt.toISOString()} ` +
      `(${Math.round(ageMs / 60000)}min ago). ` +
      `Stale threshold: ${stalenessHours}h. isStale=${isStale}`
    )

    if (isStale) {
      needsBroadcast = true
    } else {
      // Recent broadcast still active — no new one needed.
      // Existing broadcast is still valid; the cancellation organiser alert
      // (sent above) gives the organiser visibility.
      console.log(
        '[sub-requests] Existing sub request is recent — relying on existing broadcast. No new send.'
      )
    }
  }

  if (!needsBroadcast) return

  // ------------------------------------------------------------------
  // Step 4: Insert a new sub_requests record and fire the broadcast.
  //
  // request_type is always 'all_available' for post-close cancellations
  // (no first_call window for post-close — per Phase 2 Section 6.3).
  //
  // STUB: Player targeting (skill level filtering, unavailable days,
  // First Call list) is not yet implemented. The broadcast currently
  // sends a placeholder summary to the organiser instead of contacting
  // players directly. This stub is clearly marked and will be replaced
  // when lib/targeting.js is built.
  // ------------------------------------------------------------------
  console.log('[sub-requests] Inserting sub_requests record.')

  const { data: newSubRequest, error: insertError } = await supabaseAdmin
    .from('sub_requests')
    .insert({
      session_id: sessionId,
      sent_at: new Date().toISOString(),
      request_type: 'all_available', // Post-close always uses all_available
      status: 'active',
    })
    .select('id')
    .single()

  if (insertError || !newSubRequest) {
    console.error('[sub-requests] Failed to insert sub_requests record:', insertError?.message)
    return
  }

  console.log(`[sub-requests] sub_requests record created: id=${newSubRequest.id}`)

  // STUB: Send placeholder broadcast notification.
  // In production this will target all available players at the required
  // skill level (excluding unavailable days, active declines, etc.)
  // via lib/targeting.js. For now, we notify the organiser that the
  // system would have sent a broadcast, including the sub request ID
  // for reference.
  if (adminEmail) {
    await sendSubRequestBroadcastStub({
      adminEmail,
      sessionDateLabel,
      locationName,
      openSpots,
      subRequestId: newSubRequest.id,
    }).catch((err) => {
      console.error('[sub-requests] Failed to send broadcast stub notification:', err)
    })
  }

  console.log(
    `[sub-requests] handlePostCloseCancellation complete. ` +
    `subRequestId=${newSubRequest.id} openSpots=${openSpots}`
  )
}