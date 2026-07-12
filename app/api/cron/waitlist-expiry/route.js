/**
 * waitlist-expiry — Vercel Cron Job (Phase 5 of the unified dynamic
 * waitlist build sequence)
 *
 * INFRASTRUCTURE NOTE — READ BEFORE DEPLOYING:
 * This cron needs to run on a sub-daily cadence (every 15–30 minutes) to be
 * functionally meaningful — the waitlist response window it enforces is
 * measured in hours (sub_staleness_hours, default 3), not days. Every other
 * cron in this project currently runs once daily or is manually triggered
 * via curl (Vercel Hobby tier constraint — see Project Summary Section
 * "Vercel Hobby plan cron constraint," decision still open as of this
 * writing). This route is written to be logically correct and ready to
 * schedule, but it has no way to fire unattended on the current tier. Do
 * not assume this is "live" in production until the Vercel plan decision
 * is resolved and a schedule frequent enough to matter is configured.
 *
 * Decision logic:
 *   1. Query sub_requests WHERE request_type = 'waitlist' AND status =
 *      'active' AND sent_at <= now() - sub_staleness_hours.
 *      (Reuses sub_staleness_hours rather than a dedicated setting — see
 *      build discussion: a separate waitlist-window setting was considered
 *      and rejected in favor of reusing this existing, correctly
 *      hours-denominated setting, rather than reusing first_call_threshold,
 *      which is a count-of-non-responses field with an unrelated meaning.)
 *   2. For each: recompute subsNeeded fresh from current tentative count
 *      (not the value stored at broadcast time — more cancellations may
 *      have occurred during the window).
 *   3. If subsNeeded = 0: the session was already resolved by some other
 *      path (e.g. organiser manually promoted someone, which should have
 *      already closed this sub_requests row via Case D — this branch is a
 *      defensive fallback, not an expected path). Close the row and
 *      continue.
 *   4. Otherwise: close the waitlist sub_requests row (status = 'closed')
 *      and call broadcastToAllAvailable directly — bypassing
 *      evaluateAndSendSubRequest's waitlist-first check entirely, since
 *      re-running that check would just re-detect the same still-unfilled
 *      waitlisted players and re-broadcast to them instead of expanding.
 *
 * Tables read:  sub_requests, availability, sessions, admin_settings
 * Tables written: sub_requests (status → 'closed' on the expired waitlist
 *   row; broadcastToAllAvailable may insert a new all_available row)
 *
 * References:
 *   Original Automation Logic conversation — waitlist window discussion
 *     ("if it remains unfilled after X amount of time... it will be opened
 *     to the entire group")
 *   lib/sub-requests.js — broadcastToAllAvailable (extracted this revision
 *     specifically to support this cron)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { broadcastToAllAvailable } from '@/lib/sub-requests'
import { getAdminEmail } from '@/lib/admin-settings'

export async function GET(request) {
  const startTime = Date.now()
  console.log('[waitlist-expiry] Cron fired at', new Date().toISOString())

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[waitlist-expiry] Unauthorised request')
    return new Response('Unauthorised', { status: 401 })
  }

  const outcomes = { expired: 0, alreadyResolved: 0, errors: 0 }

  try {
    // ------------------------------------------------------------------
    // Step 1: Read sub_staleness_hours — the same setting used by the
    // waitlist-first staleness check in evaluateAndSendSubRequest, reused
    // here as the response window duration rather than introducing a
    // separate setting (see file header and build discussion).
    // ------------------------------------------------------------------
    const { data: settingRow } = await supabaseAdmin
      .from('admin_settings')
      .select('value')
      .eq('key', 'sub_staleness_hours')
      .maybeSingle()

    const stalenessHours = settingRow?.value ? parseFloat(settingRow.value) : 3
    const cutoffIso = new Date(Date.now() - stalenessHours * 60 * 60 * 1000).toISOString()

    console.log(`[waitlist-expiry] stalenessHours=${stalenessHours}, cutoff=${cutoffIso}`)

    // ------------------------------------------------------------------
    // Step 2: Find waitlist-first broadcasts that have exceeded the window.
    // ------------------------------------------------------------------
    const { data: expiredWaitlistRequests, error: fetchError } = await supabaseAdmin
      .from('sub_requests')
      .select(`
        id,
        session_id,
        sent_at,
        sessions (
          id,
          session_date,
          courts_available,
          cancelled_at,
          locations ( name )
        )
      `)
      .eq('request_type', 'waitlist')
      .eq('status', 'active')
      .lte('sent_at', cutoffIso)

    if (fetchError) {
      console.error('[waitlist-expiry] Error fetching expired waitlist requests:', fetchError.message)
      return new Response(JSON.stringify({ status: 'error' }), { status: 500 })
    }

    console.log(`[waitlist-expiry] Found ${expiredWaitlistRequests?.length ?? 0} expired waitlist broadcast(s).`)

    const adminEmail = await getAdminEmail()

    for (const req of expiredWaitlistRequests ?? []) {
      const session = req.sessions
      if (!session || session.cancelled_at) {
        console.log(`[waitlist-expiry] sub_request ${req.id} — session cancelled or missing. Closing row, no broadcast.`)
        await supabaseAdmin.from('sub_requests').update({ status: 'closed' }).eq('id', req.id)
        continue
      }

      // ------------------------------------------------------------------
      // Step 3: Recompute subsNeeded fresh from current tentative count —
      // not the value at original broadcast time, since more cancellations
      // may have occurred during the window.
      // ------------------------------------------------------------------
      const { data: tentativeRows, error: tentativeError } = await supabaseAdmin
        .from('availability')
        .select('id')
        .eq('session_id', session.id)
        .eq('status', 'tentative')

      if (tentativeError) {
        console.error(
          `[waitlist-expiry] Error fetching tentative count for session ${session.id}:`, tentativeError.message
        )
        outcomes.errors++
        continue
      }

      const tentativeCount = tentativeRows.length
      let subsNeeded = (4 - (tentativeCount % 4)) % 4

      console.log(
        `[waitlist-expiry] session ${session.id} — tentativeCount=${tentativeCount} subsNeeded=${subsNeeded}`
      )

      // Close the expired waitlist row regardless of outcome — it's done
      // being "the current broadcast" either way.
      const { error: closeError } = await supabaseAdmin
        .from('sub_requests')
        .update({ status: 'closed' })
        .eq('id', req.id)

      if (closeError) {
        console.error(`[waitlist-expiry] Failed to close waitlist sub_request ${req.id}:`, closeError.message)
      }

      if (subsNeeded === 0) {
        // Defensive fallback — should not normally occur, since resolving
        // to 0 tentative players via Case D should already have closed
        // this row through closeActiveSubRequest. Logged distinctly so it's
        // visible if it does happen.
        console.log(
          `[waitlist-expiry] session ${session.id} — subsNeeded=0 at expiry. ` +
          `Already resolved by another path. No broadcast needed.`
        )
        outcomes.alreadyResolved++
        continue
      }

      // ------------------------------------------------------------------
      // Step 4: Expand to all_available, bypassing waitlist-first entirely.
      // ------------------------------------------------------------------
      const sessionDateLabel = session.session_date
        ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
          })
        : 'Unknown date'
      const locationName = session.locations?.name ?? 'TBD'

      await broadcastToAllAvailable({
        sessionId: session.id,
        subsNeeded,
        sessionDateLabel,
        locationName,
        adminEmail,
      })

      outcomes.expired++
    }
  } catch (err) {
    console.error('[waitlist-expiry] Unexpected error:', err)
    return new Response(JSON.stringify({ status: 'error' }), { status: 500 })
  }

  const elapsed = Date.now() - startTime
  console.log(`[waitlist-expiry] Complete in ${elapsed}ms.`, JSON.stringify(outcomes))

  return new Response(
    JSON.stringify({ status: 'ok', outcomes, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}