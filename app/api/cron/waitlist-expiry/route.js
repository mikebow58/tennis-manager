/**
 * waitlist-expiry — Vercel Cron Job (Phase 5 of the unified dynamic
 * waitlist build sequence)
 *
 * INFRASTRUCTURE NOTE — READ BEFORE DEPLOYING:
 * This cron needs to run on a sub-daily cadence (every 15–30 minutes) to be
 * functionally meaningful. Every other cron in this project currently runs
 * once daily or is manually triggered via curl (Vercel Hobby tier
 * constraint — decision to upgrade still open). This route is written to
 * be logically correct and ready to schedule, but has no way to fire
 * unattended on the current tier.
 *
 * PHASE 7 UPDATE (this revision): now passes sessionDate through to
 * broadcastToAllAvailable, which uses it both to build a real targeting
 * pool (previously a no-op — see lib/sub-requests.js header) and to detect
 * whether the escalation_time threshold has passed since this cron last
 * ran, in which case broadcastToAllAvailable applies the late-cancellation
 * override (skill filtering suspended, request_type = 'late_cancellation')
 * automatically. No branching logic needed in this file itself — it's all
 * handled inside broadcastToAllAvailable.
 *
 * Decision logic:
 *   1. Query sub_requests WHERE request_type = 'waitlist' AND status =
 *      'active' AND sent_at <= now() - sub_staleness_hours.
 *   2. For each: recompute subsNeeded fresh from current tentative count.
 *   3. If subsNeeded = 0: already resolved by another path — close row.
 *   4. Otherwise: close the waitlist sub_requests row and call
 *      broadcastToAllAvailable directly — bypassing
 *      evaluateAndSendSubRequest's waitlist-first check entirely.
 *
 * Tables read:  sub_requests, availability, sessions, admin_settings
 * Tables written: sub_requests (status → 'closed' on the expired waitlist
 *   row; broadcastToAllAvailable may insert a new all_available or
 *   late_cancellation row)
 *
 * References:
 *   lib/sub-requests.js — broadcastToAllAvailable
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
    const { data: settingRow } = await supabaseAdmin
      .from('admin_settings')
      .select('value')
      .eq('key', 'sub_staleness_hours')
      .maybeSingle()

    const stalenessHours = settingRow?.value ? parseFloat(settingRow.value) : 3
    const cutoffIso = new Date(Date.now() - stalenessHours * 60 * 60 * 1000).toISOString()

    console.log(`[waitlist-expiry] stalenessHours=${stalenessHours}, cutoff=${cutoffIso}`)

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

      const { error: closeError } = await supabaseAdmin
        .from('sub_requests')
        .update({ status: 'closed' })
        .eq('id', req.id)

      if (closeError) {
        console.error(`[waitlist-expiry] Failed to close waitlist sub_request ${req.id}:`, closeError.message)
      }

      if (subsNeeded === 0) {
        console.log(
          `[waitlist-expiry] session ${session.id} — subsNeeded=0 at expiry. ` +
          `Already resolved by another path. No broadcast needed.`
        )
        outcomes.alreadyResolved++
        continue
      }

      const sessionDateLabel = session.session_date
        ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
          })
        : 'Unknown date'
      const locationName = session.locations?.name ?? 'TBD'

      await broadcastToAllAvailable({
        sessionId: session.id,
        subsNeeded,
        sessionDate: session.session_date, // NEW — Phase 7: enables real
        // targeting pool build and late-cancellation detection inside
        // broadcastToAllAvailable. Previously not passed.
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