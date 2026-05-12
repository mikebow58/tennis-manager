/**
 * friday-signup-send — Vercel Cron Job
 *
 * Scheduled: 09:30 Friday (admin-adjustable in admin_settings, but the Vercel
 * cron schedule itself is fixed at 09:30. If the send time changes, vercel.json
 * must also be updated to match.)
 *
 * Decision tree (Phase 1 Section 4.4):
 *   1. Query weeks WHERE week_start_date = upcoming Monday.
 *   2. status = 'approved'  → send personalised signup links to all active players
 *                             → UPDATE weeks SET status = 'sent', signup_sent_at = now()
 *   3. status = 'sent'      → manual send already fired before cron; exit, no action.
 *   4. status = 'pending_approval' → skip send; notify organiser with approval link.
 *   5. No week found        → log and exit. Nothing to do.
 *
 * Emails sent:
 *   - Active players: personalised signup link (batch via sendSignupRequestBatch)
 *   - Organiser: skip notification with approval link (via sendSignupSkippedNotification)
 *
 * DB writes:
 *   - weeks.status → 'sent', weeks.signup_sent_at = now() (approved path only)
 *
 * Tables read: weeks, players
 * Tables written: weeks
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendSignupRequestBatch,
  sendSignupSkippedNotification,
} from '@/lib/email'

export async function GET(request) {
  // Record entry time for execution duration logging.
  const startTime = Date.now()
  console.log('[friday-signup-send] Cron fired at', new Date().toISOString())

  // ------------------------------------------------------------------
  // Guard: verify the request is coming from Vercel's cron scheduler.
  // Vercel sets the Authorization header to Bearer <CRON_SECRET> on all
  // cron-triggered requests. Reject anything that doesn't match.
  // ------------------------------------------------------------------
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[friday-signup-send] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // ------------------------------------------------------------------
  // Step 1: Calculate upcoming Monday's date.
  // The cron fires on Friday. "Upcoming Monday" means the Monday of the
  // week immediately following this Friday — i.e. 3 days from now.
  // All date logic is performed in UTC to match Supabase's stored values.
  // week_start_date is stored as a date-only string: 'YYYY-MM-DD'.
  // ------------------------------------------------------------------
  const today = new Date()

  // Friday = day 5. Monday = day 1. Days until next Monday = 3.
  const daysUntilMonday = 3
  const upcomingMonday = new Date(today)
  upcomingMonday.setUTCDate(today.getUTCDate() + daysUntilMonday)

  // Format as 'YYYY-MM-DD' for the Supabase date column comparison.
  const upcomingMondayStr = upcomingMonday.toISOString().split('T')[0]
  console.log('[friday-signup-send] Looking for week with week_start_date =', upcomingMondayStr)

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
    console.error('[friday-signup-send] Error querying weeks table:', weekError.message)
    return new Response('Database error', { status: 500 })
  }

  if (!week) {
    // No week exists for upcoming Monday. This should not happen in normal
    // operation (monday_week_creation always creates it), but handle gracefully.
    console.log('[friday-signup-send] No week found for', upcomingMondayStr, '— nothing to do. Exiting.')
    return new Response(JSON.stringify({ status: 'no_week_found', weekDate: upcomingMondayStr }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  console.log('[friday-signup-send] Week found — id:', week.id, '| status:', week.status)

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
  // The organiser sent manually before this cron fired. The week is already
  // in 'sent' status. No action needed — the cron exits cleanly.
  if (week.status === 'sent') {
    console.log('[friday-signup-send] Week already in sent status — manual send preceded cron. No action. Exiting.')
    const elapsed = Date.now() - startTime
    console.log(`[friday-signup-send] Completed in ${elapsed}ms`)
    return new Response(JSON.stringify({ status: 'already_sent', weekId: week.id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // --- Branch: pending_approval — skip send, notify organiser ----------
  // Week hasn't been approved yet. Players cannot be sent an unapproved week.
  // Notify the organiser with a direct link to the approval page.
  if (week.status === 'pending_approval') {
    console.log('[friday-signup-send] Week still in pending_approval — skipping send, notifying organiser.')

    const adminEmail = process.env.ADMIN_EMAIL
    if (!adminEmail) {
      console.error('[friday-signup-send] ADMIN_EMAIL env var not set — cannot send skip notification.')
      return new Response('Configuration error: ADMIN_EMAIL not set', { status: 500 })
    }

    const notifySuccess = await sendSignupSkippedNotification({
      adminEmail,
      weekLabel,
      weekId: week.id,
    })

    if (!notifySuccess) {
      console.error('[friday-signup-send] sendSignupSkippedNotification returned false — email send failed.')
      // Return 500 so Vercel logs show a failure; the cron will not auto-retry
      // but this makes the failure visible in the dashboard.
      return new Response('Failed to send skip notification', { status: 500 })
    }

    console.log('[friday-signup-send] Skip notification sent to organiser successfully.')
    const elapsed = Date.now() - startTime
    console.log(`[friday-signup-send] Completed in ${elapsed}ms`)
    return new Response(JSON.stringify({ status: 'skipped_pending_approval', weekId: week.id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // --- Branch: approved — proceed with signup send ---------------------
  // Week is approved. Fetch all active players and send personalised signup links.
  if (week.status === 'approved') {
    console.log('[friday-signup-send] Week is approved — proceeding with signup send.')

    // Fetch all active players. We need: id (for portal URL), first_name,
    // last_name, email, and signup_token (for the personalised signup URL).
    const { data: players, error: playersError } = await supabaseAdmin
      .from('players')
      .select('id, first_name, last_name, email, signup_token')
      .eq('active', true)
      .order('last_name', { ascending: true }) // Consistent ordering for logging.

    if (playersError) {
      console.error('[friday-signup-send] Error querying players table:', playersError.message)
      return new Response('Database error', { status: 500 })
    }

    console.log(`[friday-signup-send] Found ${players.length} active players to notify.`)

    if (players.length === 0) {
      // No active players — unusual but not an error. Log and exit.
      console.warn('[friday-signup-send] No active players found — nothing to send.')
      return new Response(JSON.stringify({ status: 'no_active_players', weekId: week.id }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Build the base URL once. NEXT_PUBLIC_BASE_URL is the only safe source
    // for absolute URLs — different on dev (Vercel preview) vs production.
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

    // Build the per-player payload array. Each player gets:
    //   signupUrl  — their unique personalised signup link (token-based, no login)
    //   portalUrl  — their permanent player portal (bookmarkable, year-round access)
    const playerPayloads = players.map((player) => ({
      playerName: `${player.first_name} ${player.last_name}`,
      playerEmail: player.email,
      signupUrl: `${baseUrl}/signup/${player.signup_token}`,
      portalUrl: `${baseUrl}/portal/${player.signup_token}`,
    }))

    // Send the batch. sendSignupRequestBatch handles DEV_EMAIL_OVERRIDE
    // internally and chunks into groups of 100 for Resend's batch API.
    console.log('[friday-signup-send] Firing batch email send...')
    const { sent, failed } = await sendSignupRequestBatch(playerPayloads, weekLabel)
    console.log(`[friday-signup-send] Batch complete — sent: ${sent}, failed: ${failed}`)

    if (failed > 0) {
      // Partial failure: some emails didn't go through. Log clearly but do not
      // abort — the DB write must still happen to prevent a double-send on any
      // retry. The failure will be visible in Vercel logs and Resend dashboard.
      console.warn(`[friday-signup-send] ${failed} email(s) failed to send. Proceeding with DB update.`)
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
        '[friday-signup-send] CRITICAL: Email batch sent but failed to update weeks status.',
        'Week id:', week.id,
        'Error:', updateError.message
      )
      return new Response('Email sent but DB update failed — requires manual review', { status: 500 })
    }

    console.log(`[friday-signup-send] weeks.status → 'sent', signup_sent_at recorded. Week id: ${week.id}`)

    const elapsed = Date.now() - startTime
    console.log(`[friday-signup-send] Completed successfully in ${elapsed}ms`)

    return new Response(
      JSON.stringify({
        status: 'sent',
        weekId: week.id,
        weekLabel,
        playerCount: players.length,
        emailsSent: sent,
        emailsFailed: failed,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // ------------------------------------------------------------------
  // Fallback: week exists but has an unexpected status value.
  // This should never happen in normal operation. Log and exit.
  // ------------------------------------------------------------------
  console.warn('[friday-signup-send] Week found with unexpected status:', week.status, '— no action taken.')
  const elapsed = Date.now() - startTime
  console.log(`[friday-signup-send] Completed in ${elapsed}ms`)
  return new Response(JSON.stringify({ status: 'unexpected_week_status', weekStatus: week.status }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}