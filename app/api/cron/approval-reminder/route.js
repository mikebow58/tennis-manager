// app/api/cron/approval-reminder/route.js
//
// Vercel Cron Job — fires every Tuesday at 06:00 Mountain Time.
// vercel.json schedule: "0 12 * * 2" (12:00 UTC = 06:00 MDT)
//
// (Renamed from wednesday-approval-reminder and moved from Wednesday to
// Tuesday on Nov 17, 2026. Delete app/api/cron/wednesday-approval-reminder/
// when deploying this file.)
//
// REVISION (Nov 17, 2026 — signup send moved from Friday 9:30am to Wednesday
// 6:00pm): the organizer now has less time between week creation (Monday
// 7:00am) and the signup send, so the standard reminder moves a day earlier
// (Wednesday -> Tuesday) and the urgent reminder moves from Thursday to
// Wednesday morning (see urgent-approval-reminder). The route was renamed
// because "wednesday-approval-reminder" would have been wrong, and swapping
// the Wednesday/Thursday names between the two jobs would have been
// confusing. "Upcoming Monday" now comes from the shared Mountain-time helper
// (lib/week-dates.js) instead of a local UTC implementation; the local
// formatWeekLabel was moved there too as formatWeekRangeLabel. From Tuesday
// the upcoming Monday is 6 days ahead.
//
// IMPORTANT: UTC offset changes with daylight saving time.
// MDT (summer): UTC-6 → 06:00 MDT = 12:00 UTC → use "0 12 * * 2"
// MST (winter): UTC-7 → 06:00 MST = 13:00 UTC → use "0 13 * * 2"
// Update vercel.json when clocks change. Current: MDT (summer schedule).
//
// What this job does (Phase 1 Section 4.2):
// Step 1 — Query weeks for a pending_approval record with week_start_date
//           equal to the upcoming Monday.
// Step 2 — If found: send a standard (non-urgent) approval reminder email
//           to the organizer with a direct link to the approval page.
//           If not found (week already approved or sent): no action, exit.
//
// OQ-02 RESOLVED: This is a standalone Vercel cron job, not a conditional
// branch inside a shared job. The standard and urgent reminders run on
// different days (Tuesday and Wednesday), so they cannot share a single
// scheduled job. Two separate files is the correct implementation.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendApprovalReminderNotification } from '@/lib/email'
import { getAdminEmail } from '@/lib/admin-settings'
import { getUpcomingMondayStr, formatWeekRangeLabel } from '@/lib/week-dates'

// Vercel calls cron routes with a GET request and validates the
// CRON_SECRET header. This prevents the endpoint from being triggered
// by anyone other than Vercel's scheduler.
export async function GET(request) {
  const cronStart = Date.now()
  console.log(`[approval-reminder] START ${new Date().toISOString()}`)

  // Validate the cron secret — reject any request that isn't from Vercel.
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[approval-reminder] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // Read required settings up front.
  const adminEmail = await getAdminEmail()
  if (!adminEmail) {
    console.error('[approval-reminder] Admin email is not configured')
    return new Response('Server configuration error', { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  if (!baseUrl) {
    console.error('[approval-reminder] NEXT_PUBLIC_BASE_URL environment variable is not set')
    return new Response('Server configuration error', { status: 500 })
  }

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — Check for a pending_approval week for the upcoming Monday.
    // We only care about the week whose signup links go out this Wednesday
    // evening. A week from a prior cycle would already have been dumped by
    // monday_week_creation, so there should be at most one pending_approval
    // week at any time. We filter by week_start_date to be precise — if
    // somehow two pending weeks existed (anomalous state), we only act on the
    // relevant one.
    // -----------------------------------------------------------------------
    console.log('[approval-reminder] Step 1: checking for pending_approval week')

    const upcomingMonday = getUpcomingMondayStr()
    console.log(`[approval-reminder] Step 1: looking for week_start_date=${upcomingMonday}`)

    const { data: pendingWeeks, error: queryError } = await supabaseAdmin
      .from('weeks')
      .select('id, week_start_date, status')
      .eq('status', 'pending_approval')
      .eq('week_start_date', upcomingMonday)

    if (queryError) {
      console.error('[approval-reminder] Step 1 query error:', queryError.message)
      return new Response('Database error checking for pending week', { status: 500 })
    }

    // -----------------------------------------------------------------------
    // STEP 2 — Send reminder if pending week found, otherwise exit silently
    // -----------------------------------------------------------------------
    if (!pendingWeeks || pendingWeeks.length === 0) {
      // Week is already approved or sent — nothing to do.
      const duration = Date.now() - cronStart
      console.log(`[approval-reminder] Step 1: no pending week found for ${upcomingMonday} — week already approved or sent. Exiting. Duration: ${duration}ms`)
      return Response.json({
        success: true,
        action: 'none',
        reason: 'no_pending_week',
        upcomingMonday,
        durationMs: duration
      })
    }

    // Pending week found — send the standard (non-urgent) reminder.
    const pendingWeek = pendingWeeks[0]
    console.log(`[approval-reminder] Step 2: pending week found — id=${pendingWeek.id}, sending approval reminder`)

    // Build the approval URL and a human-readable week label for the email.
    const approvalUrl = `${baseUrl}/admin/weeks/${pendingWeek.id}/approve`
    const weekLabel = formatWeekRangeLabel(pendingWeek.week_start_date)

    const reminderSent = await sendApprovalReminderNotification({
      adminEmail,
      weekLabel,
      approvalUrl
    })

    console.log(`[approval-reminder] Step 2: reminder sent=${reminderSent}`)

    // -----------------------------------------------------------------------
    // EXIT — log duration and return outcome
    // -----------------------------------------------------------------------
    const duration = Date.now() - cronStart
    console.log(`[approval-reminder] END — reminder sent for week ${pendingWeek.id}. Duration: ${duration}ms`)

    return Response.json({
      success: true,
      action: 'reminder_sent',
      weekId: pendingWeek.id,
      weekLabel,
      reminderSent,
      durationMs: duration
    })

  } catch (err) {
    const duration = Date.now() - cronStart
    console.error(`[approval-reminder] Unhandled exception after ${duration}ms:`, err)
    return new Response('Internal server error', { status: 500 })
  }
}