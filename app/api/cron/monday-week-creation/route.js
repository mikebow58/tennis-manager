// app/api/cron/monday-week-creation/route.js
//
// Vercel Cron Job — fires every Monday at 07:00 Mountain Time.
// vercel.json schedule: "0 13 * * 1"  (13:00 UTC = 07:00 MDT / 06:00 MST)
//
// IMPORTANT: UTC offset changes with daylight saving time.
// MDT (summer): UTC-6 → 07:00 MDT = 13:00 UTC → use "0 13 * * 1"
// MST (winter): UTC-7 → 07:00 MST = 14:00 UTC → use "0 14 * * 1"
// Update vercel.json when clocks change. Current: MDT (summer schedule).
// (An earlier version of this comment listed "0 14 * * 1" as the schedule;
// the actual vercel.json entry has always been "0 13 * * 1".)
//
// What this job does (Phase 1 Section 4.1):
//   Step 1 — Check for a stale pending_approval week. If found, hard-delete it
//             and notify the organizer it was dumped.
//   Step 2 — Create a new week record in pending_approval status.
//   Step 3 — Create sessions from active default_sessions rows, applying the
//             current default start time from admin_settings.
//   Step 4 — Notify the organizer that the new week is ready for approval.
//
// REVISION (Nov 17, 2026 — signup send moved from Friday 9:30am to Wednesday
// 6:00pm):
//   This job's schedule is unchanged: the new week is still created Monday
//   7:00am. The organizer now has until Wednesday 6:00pm (about two and a half
//   days, down from about four) to approve it, with a standard reminder on
//   Tuesday 6:00am and an urgent one on Wednesday 6:00am (see
//   approval-reminder and urgent-approval-reminder). The notification email
//   copy that names the send time lives in lib/email.js
//   (sendWeekCreatedNotification) and reads lib/signup-schedule.js.
//   CODE CHANGE: the local getNextMonday() (raw UTC arithmetic) and
//   formatWeekLabel() were replaced with the shared getUpcomingMondayStr() and
//   formatWeekRangeLabel() from lib/week-dates.js, so all the weekly-cycle
//   crons compute "the Monday this week will start" the same way, in
//   Mountain time. Behavior at the real 7:00am Monday schedule is identical
//   (from Monday the next Monday is always 7 days ahead). The log message for a
//   missing admin email no longer mentions an ADMIN_EMAIL environment
//   variable — that variable was retired in favor of the admin_settings row.
//
// OPEN QUESTION OQ-01: Vercel Cron Job failure/retry behaviour is not formally
// specified. If this job fails mid-execution (e.g. weeks row inserted but
// sessions not yet), a partial week may exist in the database. The stale week
// check in Step 1 only matches pending_approval weeks from a prior cycle — it
// will not clean up a partial write from this cycle. This is flagged as the
// first V2 build priority and must be addressed before production go-live.
// Mitigation for now: extensive logging so any partial write is detectable.

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendWeekCreatedNotification,
  sendWeekDumpedNotification
} from '@/lib/email'
import { getAdminEmail } from '@/lib/admin-settings'
import { getUpcomingMondayStr, formatWeekRangeLabel } from '@/lib/week-dates'

// Vercel calls cron routes with a GET request and validates the
// CRON_SECRET header. This prevents the endpoint from being triggered
// by anyone other than Vercel's scheduler.
export async function GET(request) {
  const cronStart = Date.now()
  console.log(`[monday-week-creation] START ${new Date().toISOString()}`)

  // Validate the cron secret — reject any request that isn't from Vercel.
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[monday-week-creation] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // Read the admin email once — used for both notification types below.
  const adminEmail = await getAdminEmail()
  if (!adminEmail) {
    console.error('[monday-week-creation] Admin email is not configured')
    return new Response('Server configuration error', { status: 500 })
  }

  // Base URL for building the approval link in the notification email.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  if (!baseUrl) {
    console.error('[monday-week-creation] NEXT_PUBLIC_BASE_URL environment variable is not set')
    return new Response('Server configuration error', { status: 500 })
  }

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — Stale week check
    // Query for any week still in pending_approval. There should never be more
    // than one (enforced by this job on prior cycles), but we take the first
    // match defensively. If found, hard-delete it and all its child sessions.
    // -----------------------------------------------------------------------
    console.log('[monday-week-creation] Step 1: checking for stale pending_approval week')

    const { data: staleWeeks, error: staleError } = await supabaseAdmin
      .from('weeks')
      .select('id, week_start_date')
      .eq('status', 'pending_approval')

    if (staleError) {
      console.error('[monday-week-creation] Step 1 query error:', staleError.message)
      return new Response('Database error in stale week check', { status: 500 })
    }

    let dumpedWeekLabel = null

    if (staleWeeks && staleWeeks.length > 0) {
      // Take the first match. Log a warning if more than one exists — that
      // would indicate a prior job failure that allowed duplicates to form.
      if (staleWeeks.length > 1) {
        console.warn(`[monday-week-creation] Step 1: found ${staleWeeks.length} stale pending_approval weeks — expected at most 1. IDs: ${staleWeeks.map(w => w.id).join(', ')}`)
      }

      const staleWeek = staleWeeks[0]
      console.log(`[monday-week-creation] Step 1: stale week found — id=${staleWeek.id} week_start_date=${staleWeek.week_start_date}`)

      // Hard-delete child sessions first (FK constraint).
      const { error: sessionsDeleteError } = await supabaseAdmin
        .from('sessions')
        .delete()
        .eq('week_id', staleWeek.id)

      if (sessionsDeleteError) {
        console.error('[monday-week-creation] Step 1: failed to delete sessions for stale week:', sessionsDeleteError.message)
        return new Response('Database error deleting stale sessions', { status: 500 })
      }

      console.log(`[monday-week-creation] Step 1: deleted sessions for stale week ${staleWeek.id}`)

      // Hard-delete the stale week record itself.
      const { error: weekDeleteError } = await supabaseAdmin
        .from('weeks')
        .delete()
        .eq('id', staleWeek.id)

      if (weekDeleteError) {
        console.error('[monday-week-creation] Step 1: failed to delete stale week record:', weekDeleteError.message)
        return new Response('Database error deleting stale week', { status: 500 })
      }

      console.log(`[monday-week-creation] Step 1: stale week ${staleWeek.id} hard-deleted`)

      // Format the dumped week label for the notification email.
      // week_start_date is stored as a date string (YYYY-MM-DD).
      dumpedWeekLabel = formatWeekRangeLabel(staleWeek.week_start_date)
    } else {
      console.log('[monday-week-creation] Step 1: no stale week found — proceeding normally')
    }

    // -----------------------------------------------------------------------
    // STEP 2 — Create new week
    // week_start_date = the upcoming Monday (next Monday from today).
    // -----------------------------------------------------------------------
    console.log('[monday-week-creation] Step 2: creating new week record')

    // Called on Monday morning, so the "upcoming Monday" is always 7 days
    // ahead — the week being created for players to sign up for.
    const nextMonday = getUpcomingMondayStr()
    console.log(`[monday-week-creation] Step 2: next Monday = ${nextMonday}`)

    const { data: newWeek, error: weekInsertError } = await supabaseAdmin
      .from('weeks')
      .insert({
        week_start_date: nextMonday,
        status: 'pending_approval',
        created_at: new Date().toISOString()
      })
      .select('id, week_start_date')
      .single()

    if (weekInsertError || !newWeek) {
      console.error('[monday-week-creation] Step 2: failed to insert new week:', weekInsertError?.message)
      return new Response('Database error creating new week', { status: 500 })
    }

    console.log(`[monday-week-creation] Step 2: new week created — id=${newWeek.id} week_start_date=${newWeek.week_start_date}`)

    // -----------------------------------------------------------------------
    // STEP 3 — Create sessions from active default_sessions
    // Fetch all active default_session rows, then insert one session per
    // default row using that row's own default start time.
    // -----------------------------------------------------------------------
    console.log('[monday-week-creation] Step 3: fetching active default_sessions')

    const { data: defaultSessions, error: defaultError } = await supabaseAdmin
      .from('default_sessions')
      .select('id, day_of_week, start_time, location_id, courts_available, format, notes')
      .eq('active', true)

    if (defaultError) {
      console.error('[monday-week-creation] Step 3: failed to fetch default_sessions:', defaultError.message)
      // Week was created but sessions were not. This is the partial-write scenario
      // flagged in OQ-01. Log prominently so it can be detected and cleaned up.
      console.error(`[monday-week-creation] PARTIAL WRITE: week ${newWeek.id} created but sessions not inserted. Manual cleanup required.`)
      return new Response('Database error fetching default sessions', { status: 500 })
    }

    if (!defaultSessions || defaultSessions.length === 0) {
      console.warn('[monday-week-creation] Step 3: no active default_sessions found — week created with no sessions')
    } else {
      console.log(`[monday-week-creation] Step 3: found ${defaultSessions.length} active default session(s)`)

      // Build the session rows to insert. Each session's date is derived from
      // week_start_date plus the day offset for that day_of_week.
      const sessionRows = defaultSessions.map(ds => ({
        week_id: newWeek.id,
        session_date: getSessionDate(newWeek.week_start_date, ds.day_of_week),
        start_time: ds.start_time,  // Use default_session start_time directly per spec
        location_id: ds.location_id,
        courts_available: ds.courts_available,
        format: ds.format,
        notes: ds.notes,
        status: 'open',             // Sessions are created in open status (Phase 2 Section 4.1)
        created_at: new Date().toISOString()
      }))

      const { data: insertedSessions, error: sessionsInsertError } = await supabaseAdmin
        .from('sessions')
        .insert(sessionRows)
        .select('id, session_date')

      if (sessionsInsertError) {
        console.error('[monday-week-creation] Step 3: failed to insert sessions:', sessionsInsertError.message)
        console.error(`[monday-week-creation] PARTIAL WRITE: week ${newWeek.id} created but sessions not inserted. Manual cleanup required.`)
        return new Response('Database error inserting sessions', { status: 500 })
      }

      console.log(`[monday-week-creation] Step 3: inserted ${insertedSessions?.length ?? 0} session(s) for week ${newWeek.id}`)
    }

    // -----------------------------------------------------------------------
    // STEP 4 — Notify organizer
    // If a stale week was dumped in Step 1, send that notification first.
    // Always send the new week created notification.
    // These are fire-and-forget — email failure does not roll back the DB writes.
    // -----------------------------------------------------------------------
    console.log('[monday-week-creation] Step 4: sending organizer notification(s)')

    // Send the dumped week notification only if Step 1 found a stale week.
    if (dumpedWeekLabel) {
      const dumpedSent = await sendWeekDumpedNotification({
        adminEmail,
        dumpedWeekLabel
      })
      console.log(`[monday-week-creation] Step 4: dumped week notification sent=${dumpedSent}`)
    }

    // Build the approval URL for the new week and send the created notification.
    const weekLabel = formatWeekRangeLabel(newWeek.week_start_date)
    const approvalUrl = `${baseUrl}/admin/weeks/${newWeek.id}/approve`

    const createdSent = await sendWeekCreatedNotification({
      adminEmail,
      weekId: newWeek.id,
      weekLabel,
      approvalUrl
    })
    console.log(`[monday-week-creation] Step 4: week created notification sent=${createdSent}`)

    // -----------------------------------------------------------------------
    // EXIT — log duration and return success
    // -----------------------------------------------------------------------
    const duration = Date.now() - cronStart
    console.log(`[monday-week-creation] END — week ${newWeek.id} created successfully. Duration: ${duration}ms`)

    return Response.json({
      success: true,
      weekId: newWeek.id,
      weekLabel,
      dumpedPriorWeek: dumpedWeekLabel !== null,
      dumpedWeekLabel,
      durationMs: duration
    })

  } catch (err) {
    const duration = Date.now() - cronStart
    console.error(`[monday-week-creation] Unhandled exception after ${duration}ms:`, err)
    return new Response('Internal server error', { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// UTILITY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Computes the calendar date for a session given the week's Monday start date
 * and the session's day_of_week string.
 *
 * day_of_week values match default_sessions table: 'Monday', 'Tuesday', etc.
 * Monday offset = 0, Tuesday = 1, ..., Saturday = 5.
 *
 * @param {string} weekStartDate  - YYYY-MM-DD (always a Monday)
 * @param {string} dayOfWeek      - e.g. 'Wednesday'
 * @returns {string}              - YYYY-MM-DD
 */
function getSessionDate(weekStartDate, dayOfWeek) {
  const dayOffsets = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5
  }
  const offset = dayOffsets[dayOfWeek] ?? 0
  const date = new Date(weekStartDate)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}