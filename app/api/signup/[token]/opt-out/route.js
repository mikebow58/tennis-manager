/**
 * app/api/signup/[token]/opt-out/route.js
 *
 * Post-beta TODO item #6 — "I'm out this week."
 *
 * Whole-week, non-rescindable opt-out. Player-facing, public route (see
 * lib/supabase-middleware.js — /api/signup is registered as public).
 *
 * On success:
 *   - For every session in the current 'sent' week that is still 'open':
 *     any existing availability row for this player is HARD-DELETED
 *     (pre-close removal, per Phase 2 Section 7.3 — quiet, no notification,
 *     no sub-request logic). If the deleted row was 'confirmed',
 *     promoteFromWaitlistIfOpenSpot() is called, mirroring the existing
 *     pre-close removal pattern in /api/availability DELETE.
 *   - Sessions already 'closed' are left untouched. A closed session is a
 *     real post-close cancellation (Phase 2 Section 7.3 draws a hard line
 *     here) and must go through the existing per-session cancel link/flow
 *     — NOT silently deleted. This route reports which sessions (if any)
 *     were skipped so the client can tell the player to use their existing
 *     cancel link for those.
 *   - 'cancelled' sessions need no action either way.
 *   - A row is inserted into weekly_opt_outs (player_id, week_id). This is
 *     what lib/targeting.js checks to exclude the player from ALL fill-in
 *     /sub broadcasts this week, independent of the per-session cleanup.
 *
 * Design decisions (confirmed with organiser, Aug 2026 session):
 *   - Whole-week only, no per-day granularity.
 *   - Non-rescindable — no undo endpoint exists by design.
 *   - Mixed open/closed sessions within the same week are handled by
 *     splitting delete-vs-skip above, rather than running the full
 *     post-close cancellation flow from this route.
 *
 * BUG FIX (dev session Aug 25, 2026): the currentWeek query previously used
 * .eq('status', 'sent').single(), which assumes at most one week is ever
 * 'sent' at a time. That assumption is false by design — a new week's
 * signup send goes out Friday while the current week's sessions are still
 * running through Saturday, so two weeks are legitimately 'sent'
 * simultaneously for a multi-day window every single week. .single() throws
 * (PGRST116) whenever more than one row matches, which meant every opt-out
 * request during that overlap window was incorrectly rejected with "No
 * signup window is currently open." Fixed by ordering on week_start_date
 * descending and taking the most recent match via .maybeSingle() — same
 * fix applied to app/signup/[token]/page.js the same session.
 */

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { promoteFromWaitlistIfOpenSpot } from '@/lib/waitlist-promotion'

export async function POST(request, { params }) {
  const { token } = await params
  console.log(`[opt-out] Request received. token=${token}`)

  // ------------------------------------------------------------------
  // Validate player — same active-check as the item #11 signup page fix.
  // A deactivated player's stale link must not be able to opt out either.
  // ------------------------------------------------------------------
  const { data: player, error: playerError } = await supabaseAdmin
    .from('players')
    .select('id, first_name, last_name, active')
    .eq('signup_token', token)
    .eq('active', true)
    .single()

  if (playerError || !player) {
    console.log(`[opt-out] No active player found for token. Rejecting.`)
    return NextResponse.json({ error: 'Invalid or expired link.' }, { status: 404 })
  }

  // ------------------------------------------------------------------
  // Find the current signup week. Opting out only makes sense against a
  // week that is currently open for signup (status = 'sent') — mirrors
  // the same condition the signup page itself uses to decide whether to
  // render the day-picker at all. Most recently sent week wins when more
  // than one is 'sent' simultaneously (see bug fix note above).
  // ------------------------------------------------------------------
  const { data: currentWeek, error: weekError } = await supabaseAdmin
    .from('weeks')
    .select('id')
    .eq('status', 'sent')
    .order('week_start_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (weekError || !currentWeek) {
    console.log(`[opt-out] No week in 'sent' status. Nothing to opt out of.`)
    return NextResponse.json({ error: 'No signup window is currently open.' }, { status: 400 })
  }

  // ------------------------------------------------------------------
  // Idempotency: if this player already has an opt-out row for this week
  // (double-submit, or a stale page reload racing a prior success), treat
  // as success rather than erroring — the end state is identical either way.
  // ------------------------------------------------------------------
  const { data: existingOptOut } = await supabaseAdmin
    .from('weekly_opt_outs')
    .select('id')
    .eq('player_id', player.id)
    .eq('week_id', currentWeek.id)
    .maybeSingle()

  if (existingOptOut) {
    console.log(`[opt-out] Player ${player.id} already opted out of week ${currentWeek.id}. No-op success.`)
    return NextResponse.json({ success: true, alreadyOptedOut: true, skippedClosedSessions: [] })
  }

  // ------------------------------------------------------------------
  // Fetch all sessions for this week, with status, so open/closed can be
  // branched on individually.
  // ------------------------------------------------------------------
  const { data: sessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select('id, status, session_date')
    .eq('week_id', currentWeek.id)

  if (sessionsError) {
    console.error(`[opt-out] Failed to fetch sessions for week ${currentWeek.id}:`, sessionsError.message)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }

  const openSessions = (sessions ?? []).filter(s => s.status === 'open')
  const closedSessions = (sessions ?? []).filter(s => s.status === 'closed')
  // 'cancelled' sessions need no action — the player's spot there, if any,
  // is already suspended per Phase 3 Group 1.

  console.log(
    `[opt-out] Week ${currentWeek.id}: ${openSessions.length} open, ` +
    `${closedSessions.length} closed sessions to evaluate for player ${player.id}.`
  )

  // ------------------------------------------------------------------
  // Branch A — open sessions: quiet pre-close removal, same as the
  // existing signup-page toggle-off behaviour.
  // ------------------------------------------------------------------
  for (const session of openSessions) {
    const { data: existingRow, error: fetchRowError } = await supabaseAdmin
      .from('availability')
      .select('id, status')
      .eq('session_id', session.id)
      .eq('player_id', player.id)
      .maybeSingle()

    if (fetchRowError) {
      console.error(`[opt-out] Failed to check availability for session ${session.id}:`, fetchRowError.message)
      continue // don't let one session's error block the rest
    }

    if (!existingRow) continue // player wasn't signed up for this day — nothing to remove

    const { error: deleteError } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('id', existingRow.id)

    if (deleteError) {
      console.error(`[opt-out] Failed to delete availability ${existingRow.id}:`, deleteError.message)
      continue
    }

    console.log(`[opt-out] Deleted availability ${existingRow.id} (was '${existingRow.status}') for session ${session.id}.`)

    // Mirror the existing pre-close removal pattern: a confirmed player's
    // removal may free a spot for a waitlisted player.
    if (existingRow.status === 'confirmed') {
      await promoteFromWaitlistIfOpenSpot({
        sessionId: session.id,
        cancelledPlayerName: `${player.first_name} ${player.last_name}`,
        notifyOrganiser: true, // player-initiated, per existing convention
      })
    }
  }

  // ------------------------------------------------------------------
  // Branch B — closed sessions: leave untouched. Record the date so the
  // client can tell the player to use their existing cancel link.
  // ------------------------------------------------------------------
  const skippedClosedSessions = []

  for (const session of closedSessions) {
    const { data: existingRow } = await supabaseAdmin
      .from('availability')
      .select('id')
      .eq('session_id', session.id)
      .eq('player_id', player.id)
      .in('status', ['confirmed', 'tentative'])
      .maybeSingle()

    if (existingRow) {
      skippedClosedSessions.push(session.session_date)
      console.log(`[opt-out] Session ${session.id} is closed and player is signed up — leaving untouched, flagging for client message.`)
    }
  }

  // ------------------------------------------------------------------
  // Record the weekly opt-out.
  // ------------------------------------------------------------------
  const { error: insertError } = await supabaseAdmin
    .from('weekly_opt_outs')
    .insert({ player_id: player.id, week_id: currentWeek.id })

  if (insertError) {
    console.error(`[opt-out] Failed to insert weekly_opt_outs row:`, insertError.message)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }

  console.log(`[opt-out] Player ${player.id} opted out of week ${currentWeek.id}. skippedClosedSessions=${skippedClosedSessions.length}`)

  return NextResponse.json({
    success: true,
    alreadyOptedOut: false,
    skippedClosedSessions, // array of session_date strings the player must cancel manually
  })
}