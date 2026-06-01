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
 *   1. Runs Procedure 2 (lib/court-assignment.js — runProcedure2) to
 *      rebalance the full roster from scratch, assign court letters,
 *      and distribute players to locations on multi-location days.
 *   2. Sends the organiser a court assignment review email with the
 *      recommended court arrangements and the 8pm auto-cancel warning.
 *   3. Sets sessions.court_assignment_notified_at = now() on all
 *      sibling sessions for the day (multi-location aware).
 *   4. Closes all active sub_requests for this session — automated
 *      broadcast window is now closed. Organiser takes ownership.
 *
 * Multi-location days: runProcedure2 resolves all sibling sessions
 * automatically from the anchor session's week_id + session_date.
 * This cron deduplicates by session_date so it does not double-fire
 * for the same day when multiple sessions share it.
 *
 * Tables read:   sessions, availability, locations (join), weeks (join),
 *                admin_settings
 * Tables written: sessions (court_assignment_notified_at),
 *                 sub_requests (status → 'closed'),
 *                 court_assignments (upsert via runProcedure2),
 *                 availability (court_letter, court_assignment_status
 *                               via runProcedure2)
 * Emails sent:   sendCourtAssignmentReview — one per short session day
 *                (organiser only)
 *
 * References:
 *   Phase 1 Cron Map — Section 4.8
 *   Phase 2 State Machines — Section 4.5 (Procedure 2), Section 6.2
 *   Phase 3 Cross-Lifecycle — Group 5 (6pm fires)
 *   Automation Logic — Section 8.2 (Path B)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendCourtAssignmentReview } from '@/lib/email'
import { runProcedure2 } from '@/lib/court-assignment'
import { formatDeadlineTime } from '@/lib/utils'

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
  //
  // We deduplicate by session_date below to avoid running Procedure 2
  // multiple times on the same day when there are sibling sessions
  // (multi-location days). runProcedure2 handles all siblings internally.
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
      week_id,
      locations ( id, name ),
      weeks!inner ( status )
    `)
    .eq('session_date', tomorrowStr)
    .eq('status', 'closed')
    .is('cancelled_at', null)
    .is('court_assignment_sent_at', null)
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
  // Track which week+date combos we've already processed to avoid
  // running Procedure 2 twice on multi-location days.
  const processedDays = new Set()

  for (const session of tomorrowSessions) {
    const dayKey = `${session.week_id}:${session.session_date}`

    // ------------------------------------------------------------------
    // Check whether the session is full. This cron handles Path B only.
    // Per Phase 1 §4.8: full sessions should have been handled by
    // event-driven logic — flag as investigation item if notified_at
    // is still NULL.
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

    const isFull = (confirmedCount ?? 0) % 4 === 0

    if (isFull) {
      if (!session.court_assignment_notified_at) {
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
    // Session is short (Path B).
    // If we've already processed this day (sibling session on a
    // multi-location day), skip — Procedure 2 already ran for the whole
    // day and set notified_at on all siblings.
    // ------------------------------------------------------------------
    if (processedDays.has(dayKey)) {
      console.log(
        `[daily-6pm-court-assignment] Session ${session.id} already processed as part of ` +
        `multi-location day ${dayKey} — skipping.`
      )
      sessionsSkipped++
      continue
    }

    console.log(
      `[daily-6pm-court-assignment] Session ${session.id} (Path B — short): ` +
      `confirmed=${confirmedCount}. Running Procedure 2.`
    )

    // ------------------------------------------------------------------
    // Run Procedure 2 — full rebalancing, court letter assignment,
    // location distribution (multi-location aware).
    // ------------------------------------------------------------------
    const p2Result = await runProcedure2(session.id)

    if (!p2Result.success) {
      console.error(
        `[daily-6pm-court-assignment] Procedure 2 failed for session ${session.id}: ${p2Result.error}`
      )
      // Non-fatal — still close sub requests and set notified_at so the
      // 8pm backstop can act on current state.
    } else {
      console.log(
        `[daily-6pm-court-assignment] Procedure 2 complete for session ${session.id}: ` +
        `${p2Result.confirmedCount} confirmed, ${p2Result.tentativeCount} tentative, ` +
        `${p2Result.subsNeeded} subs needed, ${p2Result.courts.length} courts.`
      )
    }

    // ------------------------------------------------------------------
    // Close all active sub requests for all sessions on this day.
    // Per Phase 1 §4.8 and Phase 3 Group 5: 6pm is the hard cut-off
    // for automated broadcasts.
    // ------------------------------------------------------------------
    const allSessionIds = p2Result.success
      ? p2Result.sessions.map((s) => s.id)
      : [session.id]

    const { error: closeSubsError } = await supabaseAdmin
      .from('sub_requests')
      .update({ status: 'closed' })
      .in('session_id', allSessionIds)
      .eq('status', 'active')

    if (closeSubsError) {
      console.error(
        `[daily-6pm-court-assignment] Error closing sub requests for day ${dayKey}:`,
        closeSubsError.message
      )
    } else {
      console.log(
        `[daily-6pm-court-assignment] Active sub requests closed for day ${dayKey}.`
      )
    }

    // ------------------------------------------------------------------
    // Build email content from Procedure 2 result (or fallback to
    // pre-P2 counts if P2 failed).
    // ------------------------------------------------------------------
    const sessionDateLabel = formatSessionDateLabel(session.session_date)
    const startTimeLabel = formatStartTime(session.start_time)
    const locationName = session.locations?.name ?? 'TBD'

    let confirmedCountForEmail = confirmedCount ?? 0
    let tentativeCountForEmail = 0
    let subsNeededForEmail = 0
    let tentativePlayerNames = []
    let courtSummaryLines = []

    if (p2Result.success) {
      confirmedCountForEmail = p2Result.confirmedCount
      tentativeCountForEmail = p2Result.tentativeCount
      subsNeededForEmail = p2Result.subsNeeded

      // Collect tentative player names from incomplete courts.
      for (const court of p2Result.courts.filter((c) => !c.isComplete)) {
        for (const player of court.players) {
          tentativePlayerNames.push(`${player.firstName} ${player.lastName}`)
        }
      }

      // Build court summary for the email (complete courts only).
      for (const court of p2Result.courts.filter((c) => c.isComplete)) {
        const playerNames = court.players
          .map((p) => `${p.firstName} ${p.lastName}`)
          .join(', ')
        const skillRange = `${Math.min(...court.players.map((p) => p.skill))}–${Math.max(...court.players.map((p) => p.skill))}`
        const locationSuffix = p2Result.isMultiLocation ? ` · ${court.locationName}` : ''
        courtSummaryLines.push(
          `Court ${court.courtLetter}${locationSuffix}: ${playerNames} (skill ${skillRange})`
        )
      }

      if (tentativePlayerNames.length > 0) {
        const tentativeNames = tentativePlayerNames.join(', ')
        courtSummaryLines.push(`Tentative (incomplete court): ${tentativeNames}`)
      }
    } else {
      // P2 failed — fall back to raw tentative query for email content.
      const { data: tentativeAvail } = await supabaseAdmin
        .from('availability')
        .select('players ( first_name, last_name )')
        .eq('session_id', session.id)
        .eq('status', 'tentative')

      tentativeCountForEmail = tentativeAvail?.length ?? 0
      subsNeededForEmail = tentativeCountForEmail === 0
        ? 0
        : (4 - (tentativeCountForEmail % 4)) % 4 || 4
      tentativePlayerNames = (tentativeAvail ?? []).map(
        (a) => `${a.players.first_name} ${a.players.last_name}`
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
        confirmedCount: confirmedCountForEmail,
        tentativeCount: tentativeCountForEmail,
        subsNeeded: subsNeededForEmail,
        deadlineLabel,
        tentativePlayerNames,
        courtSummaryLines,
      })

      if (sent) {
        console.log(
          `[daily-6pm-court-assignment] Review email sent for day ${dayKey}.`
        )
      } else {
        console.error(
          `[daily-6pm-court-assignment] Failed to send review email for day ${dayKey}.`
        )
      }
    }

    // ------------------------------------------------------------------
    // Set court_assignment_notified_at on all sessions for this day.
    // ------------------------------------------------------------------
    const { error: notifyError } = await supabaseAdmin
      .from('sessions')
      .update({ court_assignment_notified_at: new Date().toISOString() })
      .in('id', allSessionIds)

    if (notifyError) {
      console.error(
        `[daily-6pm-court-assignment] Error setting court_assignment_notified_at for day ${dayKey}:`,
        notifyError.message
      )
    } else {
      console.log(
        `[daily-6pm-court-assignment] court_assignment_notified_at set for all sessions on day ${dayKey}.`
      )
      sessionsNotified++
    }

    processedDays.add(dayKey)
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

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function formatSessionDateLabel(sessionDate) {
  const date = new Date(sessionDate + 'T12:00:00Z')
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

function formatStartTime(startTime) {
  if (!startTime) return 'TBD'
  return new Date(`1970-01-01T${startTime}Z`).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
  })
}
