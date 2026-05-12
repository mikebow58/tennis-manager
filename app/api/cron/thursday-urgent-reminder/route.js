// app/api/cron/thursday-urgent-reminder/route.js
//
// Vercel Cron Job — fires every Thursday at 06:00 Mountain Time.
// vercel.json schedule: "0 12 * * 4" (12:00 UTC = 06:00 MDT)
//
// IMPORTANT: UTC offset changes with daylight saving time.
// MDT (summer): UTC-6 → 06:00 MDT = 12:00 UTC → use "0 12 * * 4"
// MST (winter): UTC-7 → 06:00 MST = 13:00 UTC → use "0 13 * * 4"
// Update vercel.json when clocks change. Current: MDT (summer schedule).
//
// What this job does (Phase 1 Section 4.3, Check A):
// Step 1 — Query weeks for a pending_approval record with week_start_date
//           equal to the upcoming Monday.
// Step 2 — If found: send an URGENT approval reminder to the organiser.
//           If not found (week already approved or sent): no action, exit.
//
// NOTE: thursday_weather_check (Check B) is a V2+ feature and is not
// implemented here. When it is built, it runs as a second independent check
// in this same file — Check A result does not affect Check B.
//
// OQ-02 RESOLVED: Standalone cron file, not a shared job with
// wednesday-approval-reminder. They run on different days.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendUrgentApprovalReminderNotification } from '@/lib/email'

export async function GET(request) {
  const cronStart = Date.now()
  console.log(`[thursday-urgent-reminder] START ${new Date().toISOString()}`)

  // Validate the cron secret.
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[thursday-urgent-reminder] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) {
    console.error('[thursday-urgent-reminder] ADMIN_EMAIL environment variable is not set')
    return new Response('Server configuration error', { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  if (!baseUrl) {
    console.error('[thursday-urgent-reminder] NEXT_PUBLIC_BASE_URL environment variable is not set')
    return new Response('Server configuration error', { status: 500 })
  }

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — Check for a pending_approval week for the upcoming Monday
    // From Thursday, the upcoming Monday is 4 days ahead.
    // -----------------------------------------------------------------------
    console.log('[thursday-urgent-reminder] Step 1: checking for pending_approval week')

    const upcomingMonday = getUpcomingMonday()
    console.log(`[thursday-urgent-reminder] Step 1: looking for week_start_date=${upcomingMonday}`)

    const { data: pendingWeeks, error: queryError } = await supabaseAdmin
      .from('weeks')
      .select('id, week_start_date, status')
      .eq('status', 'pending_approval')
      .eq('week_start_date', upcomingMonday)

    if (queryError) {
      console.error('[thursday-urgent-reminder] Step 1 query error:', queryError.message)
      return new Response('Database error checking for pending week', { status: 500 })
    }

    // -----------------------------------------------------------------------
    // STEP 2 — Send urgent reminder if pending week found, otherwise exit
    // -----------------------------------------------------------------------
    if (!pendingWeeks || pendingWeeks.length === 0) {
      const duration = Date.now() - cronStart
      console.log(`[thursday-urgent-reminder] Step 1: no pending week found for ${upcomingMonday} — week already approved or sent. Exiting. Duration: ${duration}ms`)
      return Response.json({
        success: true,
        action: 'none',
        reason: 'no_pending_week',
        upcomingMonday,
        durationMs: duration
      })
    }

    const pendingWeek = pendingWeeks[0]
    console.log(`[thursday-urgent-reminder] Step 2: pending week found — id=${pendingWeek.id}, sending urgent reminder`)

    const approvalUrl = `${baseUrl}/admin/weeks/${pendingWeek.id}/approve`
    const weekLabel = formatWeekLabel(pendingWeek.week_start_date)

    const reminderSent = await sendUrgentApprovalReminderNotification({
      adminEmail,
      weekLabel,
      approvalUrl
    })

    console.log(`[thursday-urgent-reminder] Step 2: urgent reminder sent=${reminderSent}`)

    // -----------------------------------------------------------------------
    // EXIT
    // -----------------------------------------------------------------------
    const duration = Date.now() - cronStart
    console.log(`[thursday-urgent-reminder] END — urgent reminder sent for week ${pendingWeek.id}. Duration: ${duration}ms`)

    return Response.json({
      success: true,
      action: 'urgent_reminder_sent',
      weekId: pendingWeek.id,
      weekLabel,
      reminderSent,
      durationMs: duration
    })

  } catch (err) {
    const duration = Date.now() - cronStart
    console.error(`[thursday-urgent-reminder] Unhandled exception after ${duration}ms:`, err)
    return new Response('Internal server error', { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// UTILITY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Returns the date string (YYYY-MM-DD) for the upcoming Monday relative to
 * today (Thursday). Thursday is day 4; Monday is day 1.
 * From Thursday, Monday is 4 days ahead (Thu → Fri → Sat → Sun → Mon).
 *
 * Written generically using the same formula as wednesday-approval-reminder
 * so it works correctly if manually tested on a day other than Thursday.
 *
 * @returns {string} YYYY-MM-DD
 */
function getUpcomingMonday() {
  const now = new Date()
  const dayOfWeek = now.getUTCDay() // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const daysUntilMonday = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() + daysUntilMonday)
  return monday.toISOString().slice(0, 10)
}

/**
 * Formats a week start date (YYYY-MM-DD Monday) into a human-readable label.
 * Example: "2026-05-18" → "May 18 – May 23"
 *
 * @param {string} weekStartDate - YYYY-MM-DD (always a Monday)
 * @returns {string}
 */
function formatWeekLabel(weekStartDate) {
  const start = new Date(weekStartDate)
  const end = new Date(weekStartDate)
  end.setUTCDate(start.getUTCDate() + 5)
  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' }
  return `${start.toLocaleDateString('en-US', options)} – ${end.toLocaleDateString('en-US', options)}`
}