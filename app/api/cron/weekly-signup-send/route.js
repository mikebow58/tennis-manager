/**
 * weekly-signup-send — Vercel Cron Job
 *
 * (Renamed from friday-signup-send on Nov 17, 2026 — see REVISION below.
 * Delete app/api/cron/friday-signup-send/ when deploying this file.)
 *
 * Scheduled: Wednesday 6:00pm Mountain (MDT).
 * vercel.json schedule: "0 0 * * 4" — that is Thursday 00:00 UTC, which is
 * Wednesday 18:00 MDT. In MST (UTC-7) the same UTC schedule fires at 5:00pm
 * local; see the daylight saving note in lib/signup-schedule.js. The send
 * time is NOT driven by admin_settings: changing a database value cannot move
 * a Vercel cron. If the send time changes, vercel.json AND
 * lib/signup-schedule.js must both be updated to match.
 *
 * REVISION (Nov 17, 2026 — signup send moved from Friday 9:30am to Wednesday
 * 6:00pm):
 *   WHY: so Monday and Tuesday sessions get the same signup window as every
 *   other day, instead of a compressed timeline that needed "anticipated"
 *   court counts. Players now have roughly Wednesday evening through the
 *   session reminder (two days prior for every session day) to sign up.
 *   WHAT CHANGED IN THIS FILE: renamed (the old name would have lied); log
 *   prefix and comments updated; "upcoming Monday" now comes from the shared
 *   Mountain-time helper in lib/week-dates.js instead of raw UTC arithmetic —
 *   at 6:00pm Mountain the UTC weekday is already Thursday, so UTC math was a
 *   trap for manual evening testing (the real schedule happened to land on the
 *   same Monday either way). Decision logic and failure behavior are
 *   otherwise unchanged. The old "no timing risk, 9:30am is nowhere near UTC
 *   midnight" note no longer applies and has been removed.
 *   NOT CHANGED: a partial email failure still marks the week 'sent' (see the
 *   failed > 0 branch below) — flagged separately in the Oct 30 handoff
 *   alongside the Resend free-plan quota (100 emails/day), which a 150-200
 *   player send exceeds.
 *
 * Decision tree (Phase 1 Section 4.4):
 *   1. Query weeks WHERE week_start_date = upcoming Monday.
 *   2. status = 'approved'  → send personalised signup links to all active players
 *                             → UPDATE weeks SET status = 'sent', signup_sent_at = now()
 *   3. status = 'sent'      → manual send already fired before cron; exit, no action.
 *   4. status = 'pending_approval' → skip send; notify organizer with approval link.
 *   5. No week found        → log and exit. Nothing to do.
 *
 * Emails sent:
 *   - Active players: personalised signup link (batch via sendSignupRequestBatch)
 *   - Organizer: skip notification with approval link (via sendSignupSkippedNotification)
 *
 * DB writes:
 *   - weeks.status → 'sent', weeks.signup_sent_at = now() (approved path only)
 *
 * Tables read: weeks, players
 * Tables written: weeks
 *
 * PRIOR REVISION (Sept 2026 session — Player page build): the per-player
 * payload's `portalUrl` field renamed to `playerPageUrl` for naming
 * consistency (per organizer decision, state handoff Sept 11 2026), and
 * its value corrected from `/portal/${token}` (a route that was never
 * built and never will be) to `/signup/${token}` — the permanent Player
 * page. lib/email.js's sendSignupRequestBatch updated to match this field
 * name in the same session.
 *
 * PRIOR BUG FIX (dev session Aug 25, 2026, part 1): "upcoming Monday" was
 * previously computed as a hardcoded `today + 3 days` — correct only when
 * this cron actually ran on a Friday. Replaced with a day-of-week-aware
 * calculation so the cron can be triggered manually on any day; superseded
 * again by the Mountain-time helper noted above.
 *
 * PRIOR BUG FIX (dev session Aug 25, 2026, part 2): elapsedMs is included in
 * every response for consistency with the other crons.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendSignupRequestBatch,
  sendSignupSkippedNotification,
} from '@/lib/email'
import { getAdminEmail } from '@/lib/admin-settings'
import { getUpcomingMondayStr } from '@/lib/week-dates'

export async function GET(request) {
  // Record entry time for execution duration logging.
  const startTime = Date.now()
  console.log('[weekly-signup-send] Cron fired at', new Date().toISOString())

  // ------------------------------------------------------------------
  // Guard: verify the request is coming from Vercel's cron scheduler.
  // Vercel sets the Authorization header to Bearer <CRON_SECRET> on all
  // cron-triggered requests. Reject anything that doesn't match.
  // ------------------------------------------------------------------
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[weekly-signup-send] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // ------------------------------------------------------------------
  // Step 1: Calculate the upcoming Monday's date — the next Monday from
  // today in Mountain time, always looking forward (never today itself,
  // even if today happens to be a Monday — this cron always targets a
  // week that hasn't started yet). week_start_date is stored as a
  // date-only string: 'YYYY-MM-DD'.
  // ------------------------------------------------------------------
  const upcomingMondayStr = getUpcomingMondayStr()
  console.log('[weekly-signup-send] Looking for week with week_start_date =', upcomingMondayStr)

  // ------------------------------------------------------------------
  // Step 2: Query the week for upcoming Monday.
  // ------------------------------------------------------------------
  const { data: week, error: weekError } = await supabaseAdmin
    .from('weeks')
    .select('id, status, week_start_date')
    .eq('week_start_date', upcomingMondayStr)
    .maybeSingle() // Returns null (not an error) if no row is found.

  if (weekError) {
    // A real database error — log and exit with 500.
    console.error('[weekly-signup-send] Error querying weeks table:', weekError.message)
    return new Response('Database error', { status: 500 })
  }

  if (!week) {
    // No week exists for upcoming Monday. This should not happen in normal
    // operation (monday_week_creation always creates it), but handle gracefully.
    const elapsed = Date.now() - startTime
    console.log('[weekly-signup-send] No week found for', upcomingMondayStr, '— nothing to do. Exiting.')
    console.log(`[weekly-signup-send] Completed in ${elapsed}ms`)
    return new Response(JSON.stringify({ status: 'no_week_found', weekDate: upcomingMondayStr, elapsedMs: elapsed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  console.log('[weekly-signup-send] Week found — id:', week.id, '| status:', week.status)

  // ------------------------------------------------------------------
  // Build a human-readable week label for email subjects.
  // Format: "May 19, 2026". This is derived from week_start_date.
  // ------------------------------------------------------------------
  const weekLabel = new Date(upcomingMondayStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

  // ------------------------------------------------------------------
  // Step 3: Branch on week status.
  // ------------------------------------------------------------------

  // --- Branch: already sent (manual send beat the cron) ---------------
  // The organizer sent manually before this cron fired. The week is already
  // in 'sent' status. No action needed — the cron exits cleanly.
  if (week.status === 'sent') {
    console.log('[weekly-signup-send] Week already in sent status — manual send preceded cron. No action. Exiting.')
    const elapsed = Date.now() - startTime
    console.log(`[weekly-signup-send] Completed in ${elapsed}ms`)
    return new Response(JSON.stringify({ status: 'already_sent', weekId: week.id, elapsedMs: elapsed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // --- Branch: pending_approval — skip send, notify organizer ----------
  // Week hasn't been approved yet. Players cannot be sent an unapproved week.
  // Notify the organizer with a direct link to the approval page.
  if (week.status === 'pending_approval') {
    console.log('[weekly-signup-send] Week still in pending_approval — skipping send, notifying organizer.')

    const adminEmail = await getAdminEmail()
    if (!adminEmail) {
      console.error('[weekly-signup-send] Admin email not configured — cannot send skip notification.')
      return new Response('Configuration error: admin email not set', { status: 500 })
    }

    const notifySuccess = await sendSignupSkippedNotification({
      adminEmail,
      weekLabel,
      weekId: week.id,
    })

    if (!notifySuccess) {
      console.error('[weekly-signup-send] sendSignupSkippedNotification returned false — email send failed.')
      // Return 500 so Vercel logs show a failure; the cron will not auto-retry
      // but this makes the failure visible in the dashboard.
      return new Response('Failed to send skip notification', { status: 500 })
    }

    console.log('[weekly-signup-send] Skip notification sent to organizer successfully.')
    const elapsed = Date.now() - startTime
    console.log(`[weekly-signup-send] Completed in ${elapsed}ms`)
    return new Response(JSON.stringify({ status: 'skipped_pending_approval', weekId: week.id, elapsedMs: elapsed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // --- Branch: approved — proceed with signup send ---------------------
  // Week is approved. Fetch all active players and send personalised signup links.
  if (week.status === 'approved') {
    console.log('[weekly-signup-send] Week is approved — proceeding with signup send.')

    // Fetch all active players. We need: id (for player page URL), first_name,
    // last_name, email, and signup_token (for the personalised signup URL).
    const { data: players, error: playersError } = await supabaseAdmin
      .from('players')
      .select('id, first_name, last_name, email, signup_token')
      .eq('active', true)
      .order('last_name', { ascending: true }) // Consistent ordering for logging.

    if (playersError) {
      console.error('[weekly-signup-send] Error querying players table:', playersError.message)
      return new Response('Database error', { status: 500 })
    }

    console.log(`[weekly-signup-send] Found ${players.length} active players to notify.`)

    if (players.length === 0) {
      // No active players — unusual but not an error. Log and exit.
      const elapsed = Date.now() - startTime
      console.warn('[weekly-signup-send] No active players found — nothing to send.')
      console.log(`[weekly-signup-send] Completed in ${elapsed}ms`)
      return new Response(JSON.stringify({ status: 'no_active_players', weekId: week.id, elapsedMs: elapsed }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Build the base URL once. NEXT_PUBLIC_BASE_URL is the only safe source
    // for absolute URLs — different on dev (Vercel preview) vs production.
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

    // Build the per-player payload array. Each player gets:
    //   signupUrl      — their unique personalised signup link (token-based, no login)
    //   playerPageUrl  — their permanent Player page (bookmarkable, year-round access).
    const playerPayloads = players.map((player) => ({
      playerFirstName: player.first_name,   // First name only — used in email greeting
      playerEmail: player.email,
      signupUrl: `${baseUrl}/signup/${player.signup_token}`,
      playerPageUrl: `${baseUrl}/signup/${player.signup_token}`,
    }))

    // Send the batch. sendSignupRequestBatch handles DEV_EMAIL_OVERRIDE
    // internally and chunks into groups of 100 for Resend's batch API.
    console.log('[weekly-signup-send] Firing batch email send...')
    const { sent, failed } = await sendSignupRequestBatch(playerPayloads, weekLabel)
    console.log(`[weekly-signup-send] Batch complete — sent: ${sent}, failed: ${failed}`)

    if (failed > 0) {
      // Partial failure: some emails didn't go through. Log clearly but do not
      // abort — the DB write must still happen to prevent a double-send on any
      // retry. The failure will be visible in Vercel logs and Resend dashboard.
      console.warn(`[weekly-signup-send] ${failed} email(s) failed to send. Proceeding with DB update.`)
    }

    // ------------------------------------------------------------------
    // Update weeks status to 'sent' and record the send timestamp.
    // This MUST happen after the email send — if the DB write is done first
    // and the email send fails, the week would be marked sent with no emails
    // delivered. Doing it after means a partial email failure still records
    // the send attempt, which is the safer failure mode.
    // ------------------------------------------------------------------
    const { error: updateError } = await supabaseAdmin
      .from('weeks')
      .update({
        status: 'sent',
        signup_sent_at: new Date().toISOString(),
      })
      .eq('id', week.id)

    if (updateError) {
      // DB write failed after emails were already sent. Log prominently — the
      // week is in an inconsistent state (emails sent but status not updated).
      // The cron will see 'approved' again if it ever re-fires and could
      // attempt a double-send. This needs manual investigation.
      console.error(
        '[weekly-signup-send] CRITICAL: Email batch sent but failed to update weeks status.',
        'Week id:', week.id,
        'Error:', updateError.message
      )
      return new Response('Email sent but DB update failed — requires manual review', { status: 500 })
    }

    console.log(`[weekly-signup-send] weeks.status → 'sent', signup_sent_at recorded. Week id: ${week.id}`)

    const elapsed = Date.now() - startTime
    console.log(`[weekly-signup-send] Completed successfully in ${elapsed}ms`)

    return new Response(
      JSON.stringify({
        status: 'sent',
        weekId: week.id,
        weekLabel,
        playerCount: players.length,
        emailsSent: sent,
        emailsFailed: failed,
        elapsedMs: elapsed,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // ------------------------------------------------------------------
  // Fallback: week exists but has an unexpected status value.
  // This should never happen in normal operation. Log and exit.
  // ------------------------------------------------------------------
  const elapsed = Date.now() - startTime
  console.warn('[weekly-signup-send] Week found with unexpected status:', week.status, '— no action taken.')
  console.log(`[weekly-signup-send] Completed in ${elapsed}ms`)
  return new Response(JSON.stringify({ status: 'unexpected_week_status', weekStatus: week.status, elapsedMs: elapsed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}