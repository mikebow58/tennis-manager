// app/api/cron/wednesday-approval-reminder/route.js
//
// Vercel Cron Job — fires every Wednesday at 06:00 Mountain Time.
// vercel.json schedule: "0 12 * * 3" (12:00 UTC = 06:00 MDT)
//
// IMPORTANT: UTC offset changes with daylight saving time.
// MDT (summer): UTC-6 → 06:00 MDT = 12:00 UTC → use "0 12 * * 3"
// MST (winter): UTC-7 → 06:00 MST = 13:00 UTC → use "0 13 * * 3"
// Update vercel.json when clocks change. Current: MDT (summer schedule).
//
// What this job does (Phase 1 Section 4.2):
// Step 1 — Query weeks for a pending_approval record with week_start_date
//           equal to the upcoming Monday.
// Step 2 — If found: send a standard (non-urgent) approval reminder email
//           to the organiser with a direct link to the approval page.
//           If not found (week already approved or sent): no action, exit.
//
// OQ-02 RESOLVED: This is a standalone Vercel cron job, not a conditional
// branch inside a shared 6am job. Wednesday and Thursday run on different
// days so they cannot share a single scheduled job. Two separate files is
// the correct implementation.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendApprovalReminderNotification } from '@/lib/email'

// Vercel calls cron routes with a GET request and validates the
// CRON_SECRET header. This prevents the endpoint from being triggered
// by anyone other than Vercel's scheduler.
export async function GET(request) {
  const cronStart = Date.now()
  console.log(`[wednesday-approval-reminder] START ${new Date().toISOString()}`)

  // Validate the cron secret — reject any request that isn't from Vercel.
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[wednesday-approval-reminder] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // Read required environment variables up front.
  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) {
    console.error('[wednesday-approval-reminder] ADMIN_EMAIL environment variable is not set')
    return new Response('Server configuration error', { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  if (!baseUrl) {
    console.error('[wednesday-approval-reminder] NEXT_PUBLIC_BASE_URL environment variable is not set')
    return new Response('Server configuration error', { status: 500 })
  }

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — Check for a pending_approval week for the upcoming Monday
    // We only care about the week whose signup window is this coming Friday.
    // A week from a prior cycle would already have been dumped by monday_week_creation,
    // so there should be at most one pending_approval week at any time.
    // We filter by week_start_date to be precise — if somehow two pending weeks
    // existed (anomalous state), we only act on the relevant one.
    // -----------------------------------------------------------------------
    console.log('[wednesday-approval-reminder] Step 1: checking for pending_approval week')

    // Compute the upcoming Monday's date. Wednesday's cron fires 2 days before
    // it, so "upcoming Monday" is 5 days from now (Wed + 5 = Mon).
    const upcomingMonday = getUpcomingMonday()
    console.log(`[wednesday-approval-reminder] Step 1: looking for week_start_date=${upcomingMonday}`)

    const { data: pendingWeeks, error: queryError } = await supabaseAdmin
      .from('weeks')
      .select('id, week_start_date, status')
      .eq('status', 'pending_approval')
      .eq('week_start_date', upcomingMonday)

    if (queryError) {
      console.error('[wednesday-approval-reminder] Step 1 query error:', queryError.message)
      return new Response('Database error checking for pending week', { status: 500 })
    }

    // -----------------------------------------------------------------------
    // STEP 2 — Send reminder if pending week found, otherwise exit silently
    // -----------------------------------------------------------------------
    if (!pendingWeeks || pendingWeeks.length === 0) {
      // Week is already approved or sent — nothing to do.
      const duration = Date.now() - cronStart
      console.log(`[wednesday-approval-reminder] Step 1: no pending week found for ${upcomingMonday} — week already approved or sent. Exiting. Duration: ${duration}ms`)
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
    console.log(`[wednesday-approval-reminder] Step 2: pending week found — id=${pendingWeek.id}, sending approval reminder`)

    // Build the approval URL and a human-readable week label for the email.
    const approvalUrl = `${baseUrl}/admin/weeks/${pendingWeek.id}/approve`
    const weekLabel = formatWeekLabel(pendingWeek.week_start_date)

    const reminderSent = await sendApprovalReminderNotification({
      adminEmail,
      weekLabel,
      approvalUrl
    })

    console.log(`[wednesday-approval-reminder] Step 2: reminder sent=${reminderSent}`)

    // -----------------------------------------------------------------------
    // EXIT — log duration and return outcome
    // -----------------------------------------------------------------------
    const duration = Date.now() - cronStart
    console.log(`[wednesday-approval-reminder] END — reminder sent for week ${pendingWeek.id}. Duration: ${duration}ms`)

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
    console.error(`[wednesday-approval-reminder] Unhandled exception after ${duration}ms:`, err)
    return new Response('Internal server error', { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// UTILITY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Returns the date string (YYYY-MM-DD) for the upcoming Monday relative to
 * today (Wednesday). Wednesday is day 3; Monday is day 1.
 * From Wednesday, Monday is 5 days ahead (Wed → Thu → Fri → Sat → Sun → Mon).
 *
 * Uses UTC date arithmetic to match the cron's UTC execution context.
 *
 * @returns {string} YYYY-MM-DD
 */
function getUpcomingMonday() {
  const now = new Date()
  const dayOfWeek = now.getUTCDay() // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

  // Days until the next Monday from today.
  // If today is Wednesday (3): (8 - 3) % 7 = 5. Correct.
  // Written generically so the function works correctly if manually tested
  // on a day other than Wednesday (e.g. during dev curl testing).
  const daysUntilMonday = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7

  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() + daysUntilMonday)
  return monday.toISOString().slice(0, 10) // YYYY-MM-DD
}

/**
 * Formats a week start date (YYYY-MM-DD Monday) into a human-readable label.
 * Mirrors the same function in monday-week-creation/route.js.
 * Example: "2026-05-18" → "May 18 – May 23"
 *
 * @param {string} weekStartDate - YYYY-MM-DD (always a Monday)
 * @returns {string} - e.g. "May 18 – May 23"
 */
function formatWeekLabel(weekStartDate) {
  const start = new Date(weekStartDate)
  const end = new Date(weekStartDate)
  end.setUTCDate(start.getUTCDate() + 5) // Monday + 5 = Saturday

  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' }
  return `${start.toLocaleDateString('en-US', options)} – ${end.toLocaleDateString('en-US', options)}`
}