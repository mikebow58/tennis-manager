/**
 * daily-8pm-backstop — Vercel Cron Job
 *
 * Scheduled: 20:00 MDT daily (02:00 UTC next day, "0 2 * * *" in vercel.json).
 * Derived from admin_settings.court_assignment_deadline (default 20:00).
 * Changing the setting does not auto-reschedule — vercel.json would need updating.
 *
 * PURPOSE (Phase 1 Section 4.9):
 * Hard backstop. Fires unconditionally for any session with unsent assignment
 * details. Does not wait for organiser action.
 *
 * STEP 1 — Auto-send court assignment details:
 *   Query sessions WHERE session_date = tomorrow AND court_assignment_sent_at IS NULL
 *   AND status = 'closed' AND cancelled_at IS NULL.
 *   For each: send court assignment details to all confirmed players.
 *   Set sessions.court_assignment_sent_at = now().
 *
 * STEP 2 — Auto-cancel incomplete courts:
 *   For each session from Step 1: find players with status = 'tentative'.
 *   If any: set their availability.status → 'cancelled'.
 *   Send court cancellation notices to those players (batch).
 *   Send backstop cancellation alert to organiser (simultaneous).
 *
 * STEP 3 — Nothing to do:
 *   If Step 1 returns 0 rows: exit cleanly. All assignments already sent.
 *
 * NOTE: Per Phase 2 Section 7.8, availability.status for tentative players
 * remains 'tentative' after the 8pm backstop fires court cancellation notices.
 * Wait — this contradicts Phase 1 Section 4.9 which says:
 *   "DB: availability.status → 'cancelled' for tentative players on cancelled courts"
 * Phase 1 governs what this cron WRITES. Phase 2 Section 7.8 says status is
 * preserved "to carry court assignment history" — but Phase 1 explicitly
 * says it transitions to cancelled. Phase 1 is the authoritative cron spec.
 * We follow Phase 1: tentative → cancelled at backstop time.
 *
 * Tables read:   sessions, availability, players, locations (join),
 *                weeks (join)
 * Tables written: sessions (court_assignment_sent_at),
 *                 availability (status → 'cancelled', cancelled_at)
 * Emails sent:
 *   - sendCourtAssignmentDetails — confirmed players (batch, per session)
 *   - sendCourtCancellationNotice — tentative players (batch, per session)
 *   - sendBackstopCancellationAlert — organiser (per session with cancellations)
 *
 * References:
 *   Phase 1 Cron Map — Section 4.9
 *   Phase 2 State Machines — Section 4.5 (Procedure 2), Section 7.2
 *   Phase 3 Cross-Lifecycle — Group 5 (8pm backstop fires)
 *   Automation Logic — Section 8.2 (Path B backstop)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendCourtAssignmentDetails,
  sendCourtCancellationNotice,
  sendBackstopCancellationAlert,
} from '@/lib/email'

export async function GET(request) {
  const startTime = Date.now()
  console.log('[daily-8pm-backstop] Cron fired at', new Date().toISOString())

  // ------------------------------------------------------------------
  // Guard: verify request is from Vercel's cron scheduler.
  // ------------------------------------------------------------------
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[daily-8pm-backstop] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // ------------------------------------------------------------------
  // Establish tomorrow's date in Mountain Time.
  // ------------------------------------------------------------------
  const nowUtc = new Date()

  function toMountainDateStr(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }

  const tomorrowDate = new Date(nowUtc)
  tomorrowDate.setUTCDate(nowUtc.getUTCDate() + 1)
  const tomorrowStr = toMountainDateStr(tomorrowDate)

  console.log('[daily-8pm-backstop] Processing sessions for tomorrow:', tomorrowStr)

  const adminEmail = process.env.ADMIN_EMAIL
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

  if (!adminEmail) {
    console.error('[daily-8pm-backstop] ADMIN_EMAIL not set — organiser alerts will not send')
  }

  // ------------------------------------------------------------------
  // STEP 1: Query sessions that still need court assignment details sent.
  // court_assignment_sent_at IS NULL means this backstop hasn't already
  // fired for this session (idempotency guard).
  // Include confirmed players and their details via availability join.
  // ------------------------------------------------------------------
  const { data: pendingSessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      session_date,
      start_time,
      courts_available,
      notes,
      locations ( name ),
      weeks!inner ( status )
    `)
    .eq('session_date', tomorrowStr)
    .eq('status', 'closed')
    .is('cancelled_at', null)
    .is('court_assignment_sent_at', null)
    .eq('weeks.status', 'sent')

  if (sessionsError) {
    console.error('[daily-8pm-backstop] Error querying pending sessions:', sessionsError.message)
    return new Response(
      JSON.stringify({ status: 'error', message: sessionsError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // ------------------------------------------------------------------
  // STEP 3 check: nothing to do if all assignments already sent.
  // ------------------------------------------------------------------
  if (pendingSessions.length === 0) {
    console.log(
      '[daily-8pm-backstop] No pending sessions — all assignments already sent before 8pm. Exiting.'
    )
    const elapsed = Date.now() - startTime
    return new Response(
      JSON.stringify({ status: 'ok', outcome: { sessionsProcessed: 0 }, elapsedMs: elapsed }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  console.log(`[daily-8pm-backstop] Found ${pendingSessions.length} session(s) to process.`)

  let sessionsProcessed = 0
  let totalConfirmedNotified = 0
  let totalTentativeCancelled = 0

  for (const session of pendingSessions) {
    // ------------------------------------------------------------------
    // Format session details used across all email sends for this session.
    // ------------------------------------------------------------------
    const sessionDate = new Date(session.session_date + 'T12:00:00Z')
    const sessionDateLabel = sessionDate.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    })

    const startTimeLabel = session.start_time
      ? new Date(`1970-01-01T${session.start_time}Z`).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
        })
      : 'TBD'

    const locationName = session.locations?.name ?? 'TBD'

    console.log(`[daily-8pm-backstop] Processing session ${session.id} (${sessionDateLabel}).`)

    // ------------------------------------------------------------------
    // Fetch all active players for this session (confirmed + tentative).
    // We need both to send the right email to each group and to write
    // the cancellation status for tentative players.
    // ------------------------------------------------------------------
    const { data: activeAvail, error: availError } = await supabaseAdmin
      .from('availability')
      .select(`
        id,
        status,
        player_id,
        players (
          first_name,
          last_name,
          email,
          signup_token
        )
      `)
      .eq('session_id', session.id)
      .in('status', ['confirmed', 'tentative'])

    if (availError) {
      console.error(
        `[daily-8pm-backstop] Error fetching availability for session ${session.id}:`,
        availError.message
      )
      continue
    }

    const confirmedAvail = activeAvail.filter((a) => a.status === 'confirmed')
    const tentativeAvail = activeAvail.filter((a) => a.status === 'tentative')

    console.log(
      `[daily-8pm-backstop] Session ${session.id}: ` +
      `confirmed=${confirmedAvail.length} tentative=${tentativeAvail.length}`
    )

    // ------------------------------------------------------------------
    // STEP 1 (continued): Send court assignment details to confirmed players.
    //
    // NOTE: Full court-specific detail (court number, partners) requires
    // Procedure 2 (lib/court-assignment.js) to be built. Until then,
    // confirmed players receive session details with a note that court
    // assignments will be posted at the venue. See sendCourtAssignmentDetails.
    // ------------------------------------------------------------------
    if (confirmedAvail.length > 0) {
      const confirmedEmailPayloads = confirmedAvail.map((a) => ({
        playerFirstName: a.players.first_name,
        playerEmail: a.players.email,
        sessionDate: sessionDateLabel,
        startTime: startTimeLabel,
        locationName,
        notes: session.notes ?? null,
        cancelUrl: `${baseUrl}/portal/${a.players.signup_token}`,
      }))

      console.log(
        `[daily-8pm-backstop] Sending court assignment details to ${confirmedAvail.length} confirmed player(s).`
      )

      const { sent, failed } = await sendCourtAssignmentDetails(confirmedEmailPayloads)
      console.log(
        `[daily-8pm-backstop] Session ${session.id} — assignment emails: sent=${sent} failed=${failed}.`
      )
      totalConfirmedNotified += sent
    }

    // ------------------------------------------------------------------
    // Set court_assignment_sent_at — do this before processing tentative
    // cancellations so the session is marked as actioned even if the
    // tentative step encounters an error.
    // ------------------------------------------------------------------
    const { error: sentAtError } = await supabaseAdmin
      .from('sessions')
      .update({ court_assignment_sent_at: new Date().toISOString() })
      .eq('id', session.id)

    if (sentAtError) {
      console.error(
        `[daily-8pm-backstop] CRITICAL — failed to set court_assignment_sent_at for session ${session.id}:`,
        sentAtError.message
      )
      // Log and continue — emails were sent above, we need the status written.
    } else {
      console.log(
        `[daily-8pm-backstop] court_assignment_sent_at set for session ${session.id}.`
      )
    }

    sessionsProcessed++

    // ------------------------------------------------------------------
    // STEP 2: Auto-cancel incomplete courts.
    // If any tentative players remain, their court cannot be completed.
    // Transition their availability.status → 'cancelled'.
    // Send them cancellation notices (batch).
    // Alert the organiser simultaneously.
    // ------------------------------------------------------------------
    if (tentativeAvail.length === 0) {
      console.log(
        `[daily-8pm-backstop] Session ${session.id} — no tentative players. No auto-cancel needed.`
      )
      continue
    }

    console.log(
      `[daily-8pm-backstop] Session ${session.id} — auto-cancelling ${tentativeAvail.length} tentative player(s).`
    )

    // Transition all tentative records to cancelled.
    const tentativeIds = tentativeAvail.map((a) => a.id)

    const { error: cancelError } = await supabaseAdmin
      .from('availability')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      })
      .in('id', tentativeIds)

    if (cancelError) {
      console.error(
        `[daily-8pm-backstop] Error cancelling tentative availability for session ${session.id}:`,
        cancelError.message
      )
      // Continue to attempt email sends even if DB write failed — players
      // should still be notified. Log the inconsistency prominently.
      console.error(
        `[daily-8pm-backstop] WARNING: DB write failed but proceeding with player notifications. ` +
        `Session ${session.id} may have orphaned tentative records — manual review required.`
      )
    } else {
      console.log(
        `[daily-8pm-backstop] ${tentativeAvail.length} tentative record(s) set to cancelled for session ${session.id}.`
      )
      totalTentativeCancelled += tentativeAvail.length
    }

    // Send cancellation notices to the tentative players (batch).
    const tentativeEmailPayloads = tentativeAvail.map((a) => ({
      playerFirstName: a.players.first_name,
      playerEmail: a.players.email,
      sessionDate: sessionDateLabel,
      startTime: startTimeLabel,
      locationName,
    }))

    const { sent: cancelSent, failed: cancelFailed } =
      await sendCourtCancellationNotice(tentativeEmailPayloads)

    console.log(
      `[daily-8pm-backstop] Session ${session.id} — cancellation notices: ` +
      `sent=${cancelSent} failed=${cancelFailed}.`
    )

    // Alert the organiser simultaneously.
    if (adminEmail) {
      const cancelledPlayerNames = tentativeAvail.map(
        (a) => `${a.players.first_name} ${a.players.last_name}`
      )

      await sendBackstopCancellationAlert({
        adminEmail,
        sessionDateLabel,
        locationName,
        cancelledCourtPlayerCount: tentativeAvail.length,
        confirmedCount: confirmedAvail.length,
        cancelledPlayerNames,
      }).catch((err) =>
        console.error(
          `[daily-8pm-backstop] Failed to send organiser alert for session ${session.id}:`, err
        )
      )
    }
  } // end for loop over pending sessions

  const elapsed = Date.now() - startTime
  const outcome = {
    sessionsProcessed,
    totalConfirmedNotified,
    totalTentativeCancelled,
  }
  console.log(`[daily-8pm-backstop] Complete in ${elapsed}ms.`, JSON.stringify(outcome))

  return new Response(
    JSON.stringify({ status: 'ok', outcome, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}