// app/api/cron/urgent-approval-reminder/route.js
//
// Vercel Cron Job — fires every Wednesday at 06:00 Mountain Time, roughly
// twelve hours before the 6:00pm signup send.
// vercel.json schedule: "0 12 * * 3" (12:00 UTC = 06:00 MDT)
//
// (Renamed from thursday-urgent-reminder and moved from Thursday to
// Wednesday on Nov 17, 2026. Delete app/api/cron/thursday-urgent-reminder/
// when deploying this file.)
//
// REVISION (Nov 17, 2026 — signup send moved from Friday 9:30am to Wednesday
// 6:00pm): the urgent reminder now fires on the morning of the send, a day
// earlier than before. 6:00am is kept because the organizer plays tennis
// Wednesday mornings (sessions start 8:00am), so the reminder is waiting
// before he leaves. The route was renamed so the name no longer lies about
// the day. "Upcoming Monday" now comes from the shared Mountain-time helper
// (lib/week-dates.js); from Wednesday it is 5 days ahead. The organizer-
// facing email copy lives in lib/email.js
// (sendUrgentApprovalReminderNotification) and now says the links go out
// today at 6:00pm.
//
// IMPORTANT: UTC offset changes with daylight saving time.
// MDT (summer): UTC-6 → 06:00 MDT = 12:00 UTC → use "0 12 * * 3"
// MST (winter): UTC-7 → 06:00 MST = 13:00 UTC → use "0 13 * * 3"
// Update vercel.json when clocks change. Current: MDT (summer schedule).
//
// What this job does (Phase 1 Section 4.3, Check A):
// Step 1 — Query weeks for a pending_approval record with week_start_date
//           equal to the upcoming Monday.
// Step 2 — If found: send an URGENT approval reminder to the organizer.
//           If not found (week already approved or sent): no action, exit.
//
// NOTE: thursday_weather_check (Check B) is a V2+ feature and is not
// implemented. The spec put it in this job's Thursday predecessor so it could
// share the 6am slot. Now that this job runs on Wednesday, a future weather
// check must either run here (Wednesday, with a forecast one day shorter
// into next week's Saturday) or get its own Thursday job — undecided. It was
// designed as an independent second check: the approval reminder's result
// must not affect it.
//
// OQ-02 RESOLVED: Standalone cron file, not a shared job with
// approval-reminder. They run on different days.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendUrgentApprovalReminderNotification } from '@/lib/email'
import { getAdminEmail } from '@/lib/admin-settings'
import { getUpcomingMondayStr, formatWeekRangeLabel } from '@/lib/week-dates'

export async function GET(request) {
  const cronStart = Date.now()
  console.log(`[urgent-approval-reminder] START ${new Date().toISOString()}`)

  // Validate the cron secret.
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[urgent-approval-reminder] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  const adminEmail = await getAdminEmail()
  if (!adminEmail) {
    console.error('[urgent-approval-reminder] Admin email is not configured')
    return new Response('Server configuration error', { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  if (!baseUrl) {
    console.error('[urgent-approval-reminder] NEXT_PUBLIC_BASE_URL environment variable is not set')
    return new Response('Server configuration error', { status: 500 })
  }

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — Check for a pending_approval week for the upcoming Monday.
    // From Wednesday, the upcoming Monday is 5 days ahead.
    // -----------------------------------------------------------------------
    console.log('[urgent-approval-reminder] Step 1: checking for pending_approval week')

    const upcomingMonday = getUpcomingMondayStr()
    console.log(`[urgent-approval-reminder] Step 1: looking for week_start_date=${upcomingMonday}`)

    const { data: pendingWeeks, error: queryError } = await supabaseAdmin
      .from('weeks')
      .select('id, week_start_date, status')
      .eq('status', 'pending_approval')
      .eq('week_start_date', upcomingMonday)

    if (queryError) {
      console.error('[urgent-approval-reminder] Step 1 query error:', queryError.message)
      return new Response('Database error checking for pending week', { status: 500 })
    }

    // -----------------------------------------------------------------------
    // STEP 2 — Send urgent reminder if pending week found, otherwise exit
    // -----------------------------------------------------------------------
    if (!pendingWeeks || pendingWeeks.length === 0) {
      const duration = Date.now() - cronStart
      console.log(`[urgent-approval-reminder] Step 1: no pending week found for ${upcomingMonday} — week already approved or sent. Exiting. Duration: ${duration}ms`)
      return Response.json({
        success: true,
        action: 'none',
        reason: 'no_pending_week',
        upcomingMonday,
        durationMs: duration
      })
    }

    const pendingWeek = pendingWeeks[0]
    console.log(`[urgent-approval-reminder] Step 2: pending week found — id=${pendingWeek.id}, sending urgent reminder`)

    const approvalUrl = `${baseUrl}/admin/weeks/${pendingWeek.id}/approve`
    const weekLabel = formatWeekRangeLabel(pendingWeek.week_start_date)

    const reminderSent = await sendUrgentApprovalReminderNotification({
      adminEmail,
      weekLabel,
      approvalUrl
    })

    console.log(`[urgent-approval-reminder] Step 2: urgent reminder sent=${reminderSent}`)

    // -----------------------------------------------------------------------
    // EXIT
    // -----------------------------------------------------------------------
    const duration = Date.now() - cronStart
    console.log(`[urgent-approval-reminder] END — urgent reminder sent for week ${pendingWeek.id}. Duration: ${duration}ms`)

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
    console.error(`[urgent-approval-reminder] Unhandled exception after ${duration}ms:`, err)
    return new Response('Internal server error', { status: 500 })
  }
}