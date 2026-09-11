/**
 * waitlist-checkpoint — Vercel Cron Job
 *
 * Registered FOUR TIMES in vercel.json, all pointing at this same route,
 * at different fixed times each day (9am / 11am / 1pm / 3pm MDT). This is
 * the standard workaround for Vercel Hobby tier's once-per-day-per-job
 * limit: Hobby now allows up to 100 distinct cron job registrations, but
 * each individual registration can still only fire once every 24 hours.
 * Four separate registrations pointed at the same handler approximates a
 * rolling ~2-hour check throughout the day without requiring any tier
 * upgrade. See dev session notes, Sept 2026, "waitlist-expiry redesign"
 * for the full design discussion — this replaces the original standalone
 * waitlist-expiry cron, which was written to run every 15-30 minutes and
 * was never actually schedulable on Hobby.
 *
 * PURPOSE:
 * Silent sweep. Calls checkAllExpiredWaitlists() (lib/sub-requests.js),
 * which finds every active `waitlist` sub_requests row across all
 * sessions whose 2-hour response window (WAITLIST_RESPONSE_WINDOW_HOURS)
 * has elapsed, closes it, and expands to all_available/late_cancellation
 * as needed.
 *
 * DELIBERATELY SENDS NO ORGANISER EMAIL. checkAllExpiredWaitlists only
 * calls broadcastToAllAvailable, which emails players — never the
 * organiser. Organiser visibility into the original cancellation already
 * happened via sendPostCloseCancellationAlert at the time of the
 * cancellation itself; this cron's job is purely to widen the net if the
 * waitlist doesn't pan out, quietly, in the background.
 *
 * This is the sweep half of the waitlist-expiry redesign. The other half
 * is event-driven: a NEW cancellation on a session with an already-
 * expired waitlist broadcast triggers the same check immediately, inside
 * evaluateAndSendSubRequest (lib/sub-requests.js). This cron exists to
 * catch sessions that never receive a second cancellation to trigger that
 * event-driven path. daily_5pm_escalation also calls the same sweep
 * function once, as a final backstop before the 6pm hard cutoff.
 *
 * Tables read:  sub_requests, availability, sessions, admin_settings (all
 *   via checkAllExpiredWaitlists / broadcastToAllAvailable)
 * Tables written: sub_requests (status → 'closed' on expired rows;
 *   broadcastToAllAvailable may insert a new all_available or
 *   late_cancellation row), sub_request_recipients
 *
 * References:
 *   lib/sub-requests.js — checkAllExpiredWaitlists, expireStaleWaitlistIfNeeded
 *   Automation Logic Section 12.4 — waitlist-first 2hr response window
 */

import { checkAllExpiredWaitlists } from '@/lib/sub-requests'

export async function GET(request) {
  const startTime = Date.now()
  console.log('[waitlist-checkpoint] Cron fired at', new Date().toISOString())

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[waitlist-checkpoint] Unauthorised request')
    return new Response('Unauthorised', { status: 401 })
  }

  let outcomes
  try {
    outcomes = await checkAllExpiredWaitlists()
  } catch (err) {
    console.error('[waitlist-checkpoint] Unexpected error:', err)
    return new Response(JSON.stringify({ status: 'error' }), { status: 500 })
  }

  const elapsed = Date.now() - startTime
  console.log(`[waitlist-checkpoint] Complete in ${elapsed}ms.`, JSON.stringify(outcomes))

  return new Response(
    JSON.stringify({ status: 'ok', outcomes, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}