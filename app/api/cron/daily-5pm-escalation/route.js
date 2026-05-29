/**
 * daily-5pm-escalation — Vercel Cron Job
 *
 * Scheduled: 17:00 MDT daily (23:00 UTC, "0 23 * * *" in vercel.json).
 * Admin-adjustable via admin_settings.escalation_time, but the Vercel
 * schedule is hardcoded — changing the setting does not automatically
 * reschedule the cron. The setting controls the email copy only in V2.
 *
 * PURPOSE:
 * Read-only check. For every closed, non-cancelled session scheduled for
 * tomorrow that is still short (has tentative players), sends the organiser
 * an escalation notice with full context and a recommendation to begin
 * manual outreach before the 6pm automated broadcast window closes.
 *
 * No database writes. No player notifications. Organiser-only.
 *
 * DECISION TREE (Phase 1 Section 4.7):
 *   1. Query sessions WHERE session_date = tomorrow AND status = 'closed'
 *      AND cancelled_at IS NULL, in a sent week.
 *   2. For each: is it short?
 *      COUNT(availability WHERE court_assignment_status = 'tentative') > 0
 *   3. If short: fetch sub request status and last cancellation time.
 *      Send escalation notice to organiser.
 *   4. If not short: no action.
 *
 * Tables read:  sessions, availability, sub_requests, weeks (via join),
 *               locations (via join), admin_settings
 * Tables written: none
 * Emails sent:  sendEscalationNotice — one per short session (organiser only)
 *
 * References:
 *   Phase 1 Cron Map — Section 4.7
 *   Phase 2 State Machines — Section 5.4 (post-close short definition)
 *   Automation Logic — Section 12.6 (escalation logic)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendEscalationNotice } from '@/lib/email'

export async function GET(request) {
  const startTime = Date.now()
  console.log('[daily-5pm-escalation] Cron fired at', new Date().toISOString())

  // ------------------------------------------------------------------
  // Guard: verify request is from Vercel's cron scheduler.
  // ------------------------------------------------------------------
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[daily-5pm-escalation] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // ------------------------------------------------------------------
  // Establish tomorrow's date in Mountain Time.
  // All session_date values are stored as 'YYYY-MM-DD' date strings.
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

  console.log('[daily-5pm-escalation] Checking sessions for tomorrow:', tomorrowStr)

  // ------------------------------------------------------------------
  // Fetch the court_assignment_deadline from admin_settings so we can
  // state the 8pm consequence accurately in the escalation email.
  // ------------------------------------------------------------------
  const { data: deadlineSetting } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'court_assignment_deadline')
    .maybeSingle()

  const rawDeadline = deadlineSetting?.value ?? '20:00'
  const deadlineLabel = formatDeadlineTime(rawDeadline)

  console.log(`[daily-5pm-escalation] Court assignment deadline: ${deadlineLabel}`)

  // ------------------------------------------------------------------
  // Query closed, non-cancelled sessions scheduled for tomorrow in a
  // sent week. Join locations for the email and weeks to filter by
  // week status (only sessions in active sent weeks matter).
  // ------------------------------------------------------------------
  const { data: tomorrowSessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      session_date,
      start_time,
      courts_available,
      locations ( name ),
      weeks!inner ( status )
    `)
    .eq('session_date', tomorrowStr)
    .eq('status', 'closed')
    .is('cancelled_at', null)
    .eq('weeks.status', 'sent')

  if (sessionsError) {
    console.error('[daily-5pm-escalation] Error querying sessions:', sessionsError.message)
    return new Response(
      JSON.stringify({ status: 'error', message: sessionsError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  console.log(`[daily-5pm-escalation] Found ${tomorrowSessions.length} closed session(s) for tomorrow.`)

  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) {
    console.error('[daily-5pm-escalation] ADMIN_EMAIL not set — cannot send escalation notices')
  }

  let escalationsSent = 0

  for (const session of tomorrowSessions) {
    // ------------------------------------------------------------------
    // Check whether this session is short post-close.
    // Post-close short definition (Phase 2 Section 5.4):
    //   COUNT(availability WHERE court_assignment_status = 'tentative') > 0
    // ------------------------------------------------------------------
    const { data: tentativeRows, error: tentativeError } = await supabaseAdmin
      .from('availability')
      .select('id, cancelled_at')
      .eq('session_id', session.id)
      .eq('court_assignment_status', 'tentative')
      .eq('status', 'tentative') // must still be actively tentative, not cancelled

    if (tentativeError) {
      console.error(
        `[daily-5pm-escalation] Error fetching tentative players for session ${session.id}:`,
        tentativeError.message
      )
      continue
    }

    const tentativeCount = tentativeRows.length

    if (tentativeCount === 0) {
      console.log(`[daily-5pm-escalation] Session ${session.id} is not short — skipping.`)
      continue
    }

    // ------------------------------------------------------------------
    // Session is short. Fetch confirmed count for the roster summary.
    // ------------------------------------------------------------------
    const { count: confirmedCount, error: confirmedError } = await supabaseAdmin
      .from('availability')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id)
      .eq('status', 'confirmed')

    if (confirmedError) {
      console.error(
        `[daily-5pm-escalation] Error fetching confirmed count for session ${session.id}:`,
        confirmedError.message
      )
      continue
    }

    // Number of players needed: players to complete the incomplete court(s).
    // Same formula used throughout the codebase.
    const subsNeeded = (4 - (tentativeCount % 4)) % 4 || 4

    // ------------------------------------------------------------------
    // Fetch the most recent sub request for this session to report its
    // status to the organiser.
    // ------------------------------------------------------------------
    const { data: latestSubRequest } = await supabaseAdmin
      .from('sub_requests')
      .select('id, status, sent_at')
      .eq('session_id', session.id)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const subRequestStatus = latestSubRequest?.status ?? null

    // ------------------------------------------------------------------
    // Fetch the most recent post-close cancellation timestamp for this
    // session. Gives the organiser context on how long ago things went
    // short. Filter to cancelled records only (status = 'cancelled').
    // ------------------------------------------------------------------
    const { data: lastCancellation } = await supabaseAdmin
      .from('availability')
      .select('cancelled_at')
      .eq('session_id', session.id)
      .eq('status', 'cancelled')
      .not('cancelled_at', 'is', null)
      .order('cancelled_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastCancelledAt = lastCancellation?.cancelled_at ?? null

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

    console.log(
      `[daily-5pm-escalation] Session ${session.id} (${sessionDateLabel}) is short: ` +
      `confirmed=${confirmedCount} tentative=${tentativeCount} subsNeeded=${subsNeeded} ` +
      `subRequestStatus=${subRequestStatus ?? 'none'}`
    )

    // ------------------------------------------------------------------
    // Send escalation notice to organiser.
    // ------------------------------------------------------------------
    if (adminEmail) {
      const sent = await sendEscalationNotice({
        adminEmail,
        sessionDateLabel,
        locationName,
        startTime: startTimeLabel,
        confirmedCount: confirmedCount ?? 0,
        tentativeCount,
        subsNeeded,
        lastCancelledAt,
        subRequestStatus,
        deadlineLabel,
      })

      if (sent) {
        console.log(
          `[daily-5pm-escalation] Escalation notice sent for session ${session.id}.`
        )
        escalationsSent++
      } else {
        console.error(
          `[daily-5pm-escalation] Failed to send escalation notice for session ${session.id}.`
        )
      }
    }
  }

  const elapsed = Date.now() - startTime
  const outcome = { escalationsSent, sessionsChecked: tomorrowSessions.length }
  console.log(`[daily-5pm-escalation] Complete in ${elapsed}ms.`, JSON.stringify(outcome))

  return new Response(
    JSON.stringify({ status: 'ok', outcome, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

/**
 * Formats a 24-hour time string (e.g. "20:00") into a display-friendly
 * string (e.g. "8:00pm"). Duplicated from lib/sub-requests.js — consider
 * extracting to lib/utils.js if used in more places.
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