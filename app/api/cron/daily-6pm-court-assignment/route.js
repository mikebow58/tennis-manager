/**
 * daily-6pm-court-assignment — Vercel Cron Job
 *
 * Scheduled: 18:00 MDT daily (00:00 UTC next day, "0 0 * * *" in vercel.json).
 * Derived time: admin_settings.court_assignment_deadline - 2h. Default 8pm
 * deadline → 6pm cron. Changing the deadline setting does not auto-reschedule
 * the Vercel cron — it would require a vercel.json update.
 *
 * PURPOSE (Path B only — Phase 1 Section 4.8):
 * Handles sessions that have never fully filled. Path AA (full at reminder
 * send) and Path A (fills after reminder) are handled event-driven — not
 * by this cron.
 *
 * For each closed, non-cancelled session scheduled for tomorrow that is
 * still short:
 *   1. Runs a Procedure 2 stub (full rebalancing deferred pending
 *      lib/court-assignment.js build — see STUB note below).
 *   2. Sends the organiser a court assignment review email with the
 *      current roster state and the 8pm auto-cancel warning.
 *   3. Sets sessions.court_assignment_notified_at = now().
 *   4. Closes all active sub_requests for this session — automated
 *      broadcast window is now closed. Organiser takes ownership.
 *
 * STUB: Procedure 2 (full court rebalancing, court number assignment,
 * multi-location assignment) is deferred pending lib/court-assignment.js.
 * The cron correctly handles all state transitions and notifications.
 * When lib/court-assignment.js is built, replace the stub section below
 * with a call to runProcedure2() and include court-specific recommendations
 * in the sendCourtAssignmentReview call.
 *
 * Tables read:   sessions, availability, locations (join), weeks (join),
 *                admin_settings
 * Tables written: sessions (court_assignment_notified_at),
 *                 sub_requests (status → 'closed')
 * Emails sent:   sendCourtAssignmentReview — one per short session (organiser only)
 *
 * References:
 *   Phase 1 Cron Map — Section 4.8
 *   Phase 2 State Machines — Section 4.5 (Procedure 2), Section 6.2
 *   Phase 3 Cross-Lifecycle — Group 5 (6pm fires)
 *   Automation Logic — Section 8.2 (Path B)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendCourtAssignmentReview } from '@/lib/email'

export async function GET(request) {
  const startTime = Date.now()
  console.log('[daily-6pm-court-assignment] Cron fired at', new Date().toISOString())

  // ------------------------------------------------------------------
  // Guard: verify request is from Vercel's cron scheduler.
  // ------------------------------------------------------------------
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[daily-6pm-court-assignment] Unauthorised request — missing or invalid CRON_SECRET')
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

  console.log('[daily-6pm-court-assignment] Checking sessions for tomorrow:', tomorrowStr)

  // ------------------------------------------------------------------
  // Read court_assignment_deadline from admin_settings.
  // Used in the organiser email and for the auto-cancel warning.
  // ------------------------------------------------------------------
  const { data: deadlineSetting } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'court_assignment_deadline')
    .maybeSingle()

  const rawDeadline = deadlineSetting?.value ?? '20:00'
  const deadlineLabel = formatDeadlineTime(rawDeadline)

  console.log(`[daily-6pm-court-assignment] Court assignment deadline: ${deadlineLabel}`)

  // ------------------------------------------------------------------
  // Query closed, non-cancelled sessions for tomorrow in a sent week
  // that have not yet received a court assignment notification.
  // court_assignment_notified_at IS NULL confirms this cron hasn't
  // already fired for this session (idempotency guard).
  // ------------------------------------------------------------------
  const { data: tomorrowSessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      session_date,
      start_time,
      courts_available,
      court_assignment_notified_at,
      court_assignment_sent_at,
      locations ( name ),
      weeks!inner ( status )
    `)
    .eq('session_date', tomorrowStr)
    .eq('status', 'closed')
    .is('cancelled_at', null)
    .is('court_assignment_sent_at', null) // skip if 8pm already fired
    .eq('weeks.status', 'sent')

  if (sessionsError) {
    console.error('[daily-6pm-court-assignment] Error querying sessions:', sessionsError.message)
    return new Response(
      JSON.stringify({ status: 'error', message: sessionsError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  console.log(
    `[daily-6pm-court-assignment] Found ${tomorrowSessions.length} session(s) to evaluate.`
  )

  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) {
    console.error('[daily-6pm-court-assignment] ADMIN_EMAIL not set — cannot send notifications')
  }

  let sessionsNotified = 0
  let sessionsSkipped = 0

  for (const session of tomorrowSessions) {
    // ------------------------------------------------------------------
    // Check whether this session is already full (Path AA/A already
    // handled by event-driven logic). If full, skip — this cron handles
    // Path B only (never fully filled).
    // Per Phase 1 §4.8: if full but court_assignment_notified_at IS NULL,
    // that's an unexpected gap — log it as an error condition.
    // ------------------------------------------------------------------
    const { count: confirmedCount, error: confirmedError } = await supabaseAdmin
      .from('availability')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id)
      .eq('status', 'confirmed')

    if (confirmedError) {
      console.error(
        `[daily-6pm-court-assignment] Error fetching confirmed count for session ${session.id}:`,
        confirmedError.message
      )
      continue
    }

    const capacity = (session.courts_available ?? 0) * 4
    const isFull = (confirmedCount ?? 0) >= capacity

    if (isFull) {
      if (!session.court_assignment_notified_at) {
        // Full session with no court assignment notification — Path AA/A
        // event-driven logic should have fired. Log as investigation item.
        console.warn(
          `[daily-6pm-court-assignment] Session ${session.id} is full but ` +
          `court_assignment_notified_at is NULL — event-driven logic may have missed this. ` +
          `Flagged for investigation.`
        )
      } else {
        console.log(
          `[daily-6pm-court-assignment] Session ${session.id} is full and already notified — skipping (Path AA/A).`
        )
      }
      sessionsSkipped++
      continue
    }

    // ------------------------------------------------------------------
    // Session is short (Path B). Fetch tentative players for the email.
    // ------------------------------------------------------------------
    const { data: tentativeAvail, error: tentativeError } = await supabaseAdmin
      .from('availability')
      .select(`
        id,
        players ( first_name, last_name )
      `)
      .eq('session_id', session.id)
      .eq('status', 'tentative')

    if (tentativeError) {
      console.error(
        `[daily-6pm-court-assignment] Error fetching tentative players for session ${session.id}:`,
        tentativeError.message
      )
      continue
    }

    const tentativeCount = tentativeAvail.length
    const subsNeeded = (4 - (tentativeCount % 4)) % 4 || 4

    const tentativePlayerNames = tentativeAvail.map(
      (a) => `${a.players.first_name} ${a.players.last_name}`
    )

    // ------------------------------------------------------------------
    // STUB: Procedure 2 — Full Court Rebalancing.
    //
    // In production, this is where lib/court-assignment.js (runProcedure2)
    // would be called to:
    //   1. Rebalance the full current roster from scratch.
    //   2. Assign court numbers and locations (multi-location days).
    //   3. Generate court-specific recommendations for the organiser.
    //
    // Until lib/court-assignment.js is built, we skip the rebalancing
    // and send the organiser the current confirmed/tentative state with
    // a general recommendation. The state machine transitions (sub request
    // close, notified_at timestamp) are still correct.
    // ------------------------------------------------------------------
    console.log(
      `[daily-6pm-court-assignment] Session ${session.id} (Path B — short): ` +
      `confirmed=${confirmedCount} tentative=${tentativeCount} subsNeeded=${subsNeeded}. ` +
      `Procedure 2 stub — skipping rebalancing algorithm.`
    )

    // ------------------------------------------------------------------
    // Format session details for the email.
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

    // ------------------------------------------------------------------
    // Close all active sub requests for this session.
    // Per Phase 1 §4.8 and Phase 3 Group 5: the 6pm cron is the hard
    // cut-off for automated broadcasts. Organiser takes ownership of
    // manual outreach in the 6pm–8pm window.
    // ------------------------------------------------------------------
    const { error: closeSubsError } = await supabaseAdmin
      .from('sub_requests')
      .update({ status: 'closed' })
      .eq('session_id', session.id)
      .eq('status', 'active')

    if (closeSubsError) {
      console.error(
        `[daily-6pm-court-assignment] Error closing sub requests for session ${session.id}:`,
        closeSubsError.message
      )
      // Non-fatal — proceed with notification and notified_at write.
    } else {
      console.log(
        `[daily-6pm-court-assignment] Active sub requests closed for session ${session.id}.`
      )
    }

    // ------------------------------------------------------------------
    // Send court assignment review email to organiser.
    // ------------------------------------------------------------------
    if (adminEmail) {
      const sent = await sendCourtAssignmentReview({
        adminEmail,
        sessionDateLabel,
        locationName,
        startTime: startTimeLabel,
        confirmedCount: confirmedCount ?? 0,
        tentativeCount,
        subsNeeded,
        deadlineLabel,
        tentativePlayerNames,
      })

      if (sent) {
        console.log(
          `[daily-6pm-court-assignment] Review email sent for session ${session.id}.`
        )
      } else {
        console.error(
          `[daily-6pm-court-assignment] Failed to send review email for session ${session.id}.`
        )
      }
    }

    // ------------------------------------------------------------------
    // Set court_assignment_notified_at on the session record.
    // This marks that the organiser has been notified for this session
    // at the 6pm checkpoint. Used by the 8pm backstop to confirm the
    // notification chain is complete.
    // ------------------------------------------------------------------
    const { error: notifyError } = await supabaseAdmin
      .from('sessions')
      .update({ court_assignment_notified_at: new Date().toISOString() })
      .eq('id', session.id)

    if (notifyError) {
      console.error(
        `[daily-6pm-court-assignment] Error setting court_assignment_notified_at for session ${session.id}:`,
        notifyError.message
      )
    } else {
      console.log(
        `[daily-6pm-court-assignment] court_assignment_notified_at set for session ${session.id}.`
      )
      sessionsNotified++
    }
  }

  const elapsed = Date.now() - startTime
  const outcome = {
    sessionsNotified,
    sessionsSkipped,
    sessionsChecked: tomorrowSessions.length,
  }
  console.log(`[daily-6pm-court-assignment] Complete in ${elapsed}ms.`, JSON.stringify(outcome))

  return new Response(
    JSON.stringify({ status: 'ok', outcome, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

/**
 * Formats a 24-hour time string (e.g. "20:00") into a display-friendly
 * string (e.g. "8:00pm").
 *
 * @param {string} time24
 * @returns {string}
 */
function formatDeadlineTime(time24) {
  const [hourStr, minuteStr] = time24.split(':')
  const hour = parseInt(hourStr, 10)
  const minute = parseInt(minuteStr, 10)
  const period = hour >= 12 ? 'pm' : 'am'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  const displayMinute = minute === 0 ? '' : `:${minuteStr}`
  return `${displayHour}${displayMinute}${period}`
}