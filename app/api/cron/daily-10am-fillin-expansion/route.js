/**
 * daily-10am-fillin-expansion — Vercel Cron Job
 *
 * Scheduled: derived from daily_8am base time + 2 hours.
 * Default: 10:00 MDT (16:00 UTC, "0 16 * * *" in vercel.json).
 * Applies to any session that received a first_call broadcast this
 * morning, regardless of day of week (see fix note below).
 *
 * Fires 2 hours after daily-8am's Check B Step 5.5. If a first_call
 * sub request was sent this morning and the session is still short,
 * expands the broadcast to all available players at the required
 * skill level.
 *
 * If the all-available pool (match-type-compatible) is empty, expands
 * further to include players regardless of match type preference.
 *
 * FIX (this revision): previously filtered candidate sub_requests to
 * sessions.session_date = tomorrow. That assumption held when the only
 * source of first_call requests was the old daily-8am Check A, which
 * only ever (attempted to) fire for Wed–Sat sessions dated tomorrow.
 * Check A has since been retired — first_call requests now fire from
 * daily-8am Check B Step 5.5 for every day of week, at reminder-send
 * time. For Mon/Tue, reminder fires 1 day prior, so session_date really
 * is tomorrow. For Wed–Sat, reminder fires 2 days prior, so session_date
 * is the day AFTER tomorrow relative to this cron's run time. The old
 * filter silently excluded every Wed–Sat expansion check.
 *
 * The session_date filter was never doing necessary scoping work in the
 * first place — request_type = 'first_call' AND status = 'active' AND
 * DATE(sent_at) = today already uniquely identifies "broadcasts fired by
 * this morning's daily-8am run," independent of which day the underlying
 * session falls on. That filter alone is sufficient and is now the only
 * scoping applied. session_date is still read (needed per-session for
 * skill-exclusion day labels and email date labels) but no longer used
 * as a query filter.
 *
 * Decision tree (Phase 1 Section 4.6, as amended by this fix):
 *   1. Query sub_requests WHERE request_type = 'first_call'
 *      AND status = 'active' AND DATE(sent_at) = today.
 *   2. If 0 rows: no fill-in sent this morning — exit.
 *   3. For each: check if session is now full.
 *   4. If full: no action.
 *   5. If still short: build all-available targeting pool (using this
 *      session's own day-of-week label, not a global "tomorrow"),
 *      insert sub_requests record (request_type = 'all_available'),
 *      insert sub_request_recipients rows, send stub broadcast.
 *
 * References:
 *   Phase 1 Section 4.6 — daily_10am_fillin_expansion
 *   Automation Logic Section 6.1
 *   See daily-8am/route.js header comment for the full Check A retirement
 *   explanation and the known-gap note that led to this fix.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendSubRequestBroadcastStub } from '@/lib/email'
import { resolveSkill } from '@/lib/court-balancing'
import { buildTargetingPool } from '@/lib/targeting'
import { getAdminEmail } from '@/lib/admin-settings'

export async function GET(request) {
  const startTime = Date.now()
  console.log('[daily-10am-fillin-expansion] Cron fired at', new Date().toISOString())

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[daily-10am-fillin-expansion] Unauthorised request')
    return new Response('Unauthorised', { status: 401 })
  }

  const nowUtc = new Date()

  function toMountainDateStr(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }

  const todayStr = toMountainDateStr(nowUtc)

  console.log('[daily-10am-fillin-expansion] Today (MT):', todayStr)

  const outcomes = { expansionsSent: 0, sessionsAlreadyFull: 0, noFillInThisMorning: 0 }

  try {
    // ------------------------------------------------------------------
    // Step 1: Find first_call sub requests sent today, for ANY session
    // day. No session_date filter — see file header for why that filter
    // was removed. DATE(sent_at) = today (scoped via gte todayStart) is
    // the only scoping needed: it identifies exactly the broadcasts this
    // morning's daily-8am Check B Step 5.5 fired, regardless of whether
    // the underlying session is tomorrow (Mon/Tue) or the day after
    // tomorrow (Wed–Sat).
    // ------------------------------------------------------------------
    const todayStart = new Date(todayStr + 'T00:00:00Z').toISOString()

    const { data: firstCallRequests, error: fetchError } = await supabaseAdmin
      .from('sub_requests')
      .select(`
        id,
        session_id,
        sessions (
          id,
          session_date,
          start_time,
          courts_available,
          match_type,
          status,
          cancelled_at,
          locations ( name )
        )
      `)
      .eq('request_type', 'first_call')
      .eq('status', 'active')
      .gte('sent_at', todayStart)

    if (fetchError) {
      console.error('[daily-10am-fillin-expansion] Error fetching first_call requests:', fetchError.message)
      return new Response(JSON.stringify({ status: 'error' }), { status: 500 })
    }

    const relevantRequests = firstCallRequests ?? []

    console.log(
      `[daily-10am-fillin-expansion] Found ${relevantRequests.length} first_call ` +
      `request(s) sent today, across all session days.`
    )

    if (relevantRequests.length === 0) {
      console.log('[daily-10am-fillin-expansion] No fill-in sent this morning — nothing to expand.')
      outcomes.noFillInThisMorning = 1
    }

    const adminEmail = await getAdminEmail()

    for (const request of relevantRequests) {
      const session = request.sessions
      if (!session || session.cancelled_at) {
        console.log(
          `[daily-10am-fillin-expansion] sub_request ${request.id} — session cancelled or missing. Skipping.`
        )
        continue
      }

      // ----------------------------------------------------------------
      // Per-session day label — derived from this session's own
      // session_date, not a single global "tomorrow." Required for both
      // the skill/day-exclusion targeting check and the email date label,
      // since a single cron run may now process a mix of Mon/Tue sessions
      // (dated tomorrow) and Wed–Sat sessions (dated the day after
      // tomorrow) in the same pass.
      // ----------------------------------------------------------------
      const sessionDateObj = new Date(session.session_date + 'T12:00:00Z')
      const sessionDayLabel = sessionDateObj.toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'UTC',
      })
      const sessionDateLabelForEmail = sessionDateObj.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })

      // ----------------------------------------------------------------
      // Step 2: Check if session is now full.
      // ----------------------------------------------------------------
      const { data: confirmedAvail, error: confirmedError } = await supabaseAdmin
        .from('availability')
        .select('player_id, players ( skill_admin, skill_self )')
        .eq('session_id', session.id)
        .eq('status', 'confirmed')

      if (confirmedError) {
        console.error(
          `[daily-10am-fillin-expansion] Error fetching availability for session ${session.id}:`,
          confirmedError.message
        )
        continue
      }

      const confirmedCount = confirmedAvail.length
      const isShort = confirmedCount % 4 !== 0

      console.log(
        `[daily-10am-fillin-expansion] Session ${session.id} (${session.session_date}) — ` +
        `confirmedCount=${confirmedCount} isShort=${isShort}`
      )

      if (!isShort) {
        console.log(
          `[daily-10am-fillin-expansion] Session ${session.id} is now full — no expansion needed.`
        )
        outcomes.sessionsAlreadyFull++
        continue
      }

      // ----------------------------------------------------------------
      // Step 3: Build all-available targeting pool.
      // ----------------------------------------------------------------
      const rosterSkills = confirmedAvail.map((a) => resolveSkill(a.players))
      const sessionMatchType = session.match_type ?? 'doubles'
      const locationName = session.locations?.name ?? 'TBD'

      const { allAvailablePool, allAvailableExpandedPool } = await buildTargetingPool({
        sessionId: session.id,
        sessionDayLabel,
        sessionMatchType,
        rosterSkills,
      })

      // Use expanded pool as fallback if all-available pool is empty.
      const targetPool = allAvailablePool.length > 0 ? allAvailablePool : allAvailableExpandedPool
      const poolType = allAvailablePool.length > 0 ? 'all_available' : 'all_available_expanded'

      console.log(
        `[daily-10am-fillin-expansion] Session ${session.id} — ` +
        `targetPool=${targetPool.length} (${poolType})`
      )

      // ----------------------------------------------------------------
      // Step 4: Insert sub_requests record.
      // ----------------------------------------------------------------
      const { data: subRequest, error: subInsertError } = await supabaseAdmin
        .from('sub_requests')
        .insert({
          session_id: session.id,
          sent_at: new Date().toISOString(),
          request_type: 'all_available',
          status: 'active',
        })
        .select('id')
        .single()

      if (subInsertError || !subRequest) {
        console.error(
          `[daily-10am-fillin-expansion] Failed to insert sub_requests for session ${session.id}:`,
          subInsertError?.message
        )
        continue
      }

      console.log(
        `[daily-10am-fillin-expansion] sub_requests record created id=${subRequest.id}`
      )

      // ----------------------------------------------------------------
      // Step 5: Insert sub_request_recipients rows.
      // ----------------------------------------------------------------
      if (targetPool.length > 0) {
        const recipientRows = targetPool.map((player) => ({
          sub_request_id: subRequest.id,
          player_id: player.playerId,
          sent_at: new Date().toISOString(),
          response: 'no_response',
        }))

        const { error: recipientsError } = await supabaseAdmin
          .from('sub_request_recipients')
          .insert(recipientRows)

        if (recipientsError) {
          console.error(
            `[daily-10am-fillin-expansion] Error inserting recipients for session ${session.id}:`,
            recipientsError.message
          )
        } else {
          console.log(
            `[daily-10am-fillin-expansion] ${recipientRows.length} sub_request_recipients inserted.`
          )
        }
      } else {
        console.log(
          `[daily-10am-fillin-expansion] Session ${session.id} — no eligible players in pool.`
        )
      }

      // ----------------------------------------------------------------
      // Step 6: Send stub broadcast.
      // ----------------------------------------------------------------
      if (adminEmail) {
        await sendSubRequestBroadcastStub({
          adminEmail,
          sessionDateLabel: sessionDateLabelForEmail,
          locationName,
          openSpots: 4 - (confirmedCount % 4),
          subRequestId: subRequest.id,
        }).catch((err) =>
          console.error(
            `[daily-10am-fillin-expansion] Stub broadcast failed for session ${session.id}:`, err
          )
        )
      }

      outcomes.expansionsSent++
    }
  } catch (err) {
    console.error('[daily-10am-fillin-expansion] Unexpected error:', err)
    return new Response(JSON.stringify({ status: 'error' }), { status: 500 })
  }

  const elapsed = Date.now() - startTime
  console.log(
    `[daily-10am-fillin-expansion] Complete in ${elapsed}ms.`,
    JSON.stringify(outcomes)
  )

  return new Response(
    JSON.stringify({ status: 'ok', outcomes, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}