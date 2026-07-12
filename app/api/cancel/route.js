/**
 * /api/cancel
 *
 * Player-facing cancellation route. Called from the cancel page
 * (app/cancel/[token]/[sessionId]/page.js) when a player confirms
 * they want to cancel their spot. This is the route behind the
 * "Can't make it? Cancel your spot" links embedded in reminder and
 * confirmation emails — a separate, parallel path from /api/availability
 * DELETE (used by SignupForm.js's toggle-and-resubmit flow).
 *
 * Behaviour depends on session status:
 *   - Pre-close (session.status = 'open'): hard-delete the availability
 *     record. No notifications, no sub request logic beyond waitlist
 *     promotion (see below). Pre-close removals are quiet and reversible —
 *     Phase 2 Section 7.3.
 *
 *     PRE-CLOSE WAITLIST PROMOTION (added this revision — closing a gap
 *     identified after Phase 3 of the unified dynamic waitlist build
 *     sequence): if the removed record's status was 'confirmed', checks
 *     whether a waitlisted player can now be promoted (see
 *     lib/waitlist-promotion.js). notifyOrganiser is TRUE here — same as
 *     /api/availability DELETE — since a player-initiated cancellation
 *     gives the organiser no other visibility into it. This was missed in
 *     the original Phase 3 pass because this file was not reviewed at that
 *     time; only /api/availability DELETE was updated, leaving the more
 *     commonly-used email-link cancellation path without promotion logic
 *     until now.
 *
 *   - Post-close (session.status = 'closed'): transition availability to
 *     'cancelled' and trigger post-close cancellation logic (organiser
 *     alert + sub request evaluation) — Phase 2 Section 7.2. Unchanged.
 *
 * No auth session required — player identity is validated via signup_token
 * matching the player record. This is a public route.
 *
 * Tables read:  players, sessions, availability
 * Tables written: availability (delete, status update, or promotion update)
 * Side effects: post-close cancellation triggers lib/sub-requests.js;
 *   pre-close removal of a confirmed player triggers
 *   lib/waitlist-promotion.js
 *
 * References:
 *   lib/waitlist-promotion.js — promotion logic and email sends
 *   app/api/availability/route.js — the parallel route this now matches
 */

import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { handlePostCloseCancellation } from '@/lib/sub-requests'
import { promoteFromWaitlistIfOpenSpot } from '@/lib/waitlist-promotion'

export async function POST(request) {
  const { availabilityId, playerId, sessionId, signup_token } = await request.json()

  console.log('[api/cancel] POST received', { availabilityId, playerId, sessionId })

  // ------------------------------------------------------------------
  // Validate the signup_token to confirm this player owns this record.
  // ------------------------------------------------------------------
  if (!signup_token || !playerId) {
    console.warn('[api/cancel] Missing token or playerId')
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name, last_name')
    .eq('signup_token', signup_token)
    .eq('id', playerId)
    .eq('active', true)
    .single()

  if (playerError || !player) {
    console.warn('[api/cancel] Token validation failed', playerError?.message)
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ------------------------------------------------------------------
  // Fetch the session — we need status and location for branching logic
  // and for the cancellation alert email.
  // ------------------------------------------------------------------
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, status, session_date, start_time, courts_available, locations ( name )')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    console.error('[api/cancel] Session not found:', sessionError?.message)
    return Response.json({ error: 'Session not found' }, { status: 404 })
  }

  console.log(`[api/cancel] Session status: ${session.status} | Player: ${player.first_name} ${player.last_name}`)

  // ------------------------------------------------------------------
  // Branch on session status.
  //
  // Pre-close (status = 'open'): hard-delete + waitlist promotion check.
  // Post-close (status = 'closed'): status transition + cancellation flow.
  // Other (cancelled session etc.): hard-delete, no downstream effects.
  // ------------------------------------------------------------------
  if (session.status === 'open') {
    // Pre-close: fetch prior status first, so we know whether promotion
    // logic applies after the delete (only relevant if the player being
    // removed was 'confirmed' — a waitlisted player removing themselves
    // frees no confirmed spot, per Phase 2 Section 7.5).
    console.log(`[api/cancel] Session open — hard-deleting availability ${availabilityId}`)

    const { data: currentAvail, error: currentAvailError } = await supabase
      .from('availability')
      .select('status')
      .eq('id', availabilityId)
      .eq('player_id', playerId)
      .single()

    if (currentAvailError || !currentAvail) {
      console.error('[api/cancel] Could not fetch current availability status (pre-close):', currentAvailError?.message)
      return Response.json({ error: 'Error cancelling' }, { status: 500 })
    }

    const priorStatus = currentAvail.status

    const { error } = await supabase
      .from('availability')
      .delete()
      .eq('id', availabilityId)
      .eq('player_id', playerId) // Safety: ensure player only deletes their own record

    if (error) {
      console.error('[api/cancel] Hard-delete error:', error.message)
      return Response.json({ error: 'Error cancelling' }, { status: 500 })
    }

    console.log('[api/cancel] Pre-close hard-delete complete')

    // PRE-CLOSE WAITLIST PROMOTION — only when the removed player was
    // 'confirmed'. notifyOrganiser: true — player-initiated cancellation,
    // same as /api/availability DELETE, since the organiser has no other
    // visibility into this action.
    if (priorStatus === 'confirmed') {
      const playerName = `${player.first_name} ${player.last_name}`.trim()
      try {
        await promoteFromWaitlistIfOpenSpot({
          sessionId,
          cancelledPlayerName: playerName,
          notifyOrganiser: true,
        })
      } catch (err) {
        console.error(
          `[api/cancel] Promotion check failed for session ${sessionId}:`, err
        )
      }
    }

    return Response.json({ success: true, action: 'deleted' })

  } else if (session.status === 'closed') {
    // Post-close: status transition + cancellation flow. Unchanged.
    console.log(`[api/cancel] Session closed — transitioning availability ${availabilityId} to cancelled`)

    const { data: currentAvail, error: currentAvailError } = await supabase
      .from('availability')
      .select('status')
      .eq('id', availabilityId)
      .eq('player_id', playerId)
      .single()

    if (currentAvailError || !currentAvail) {
      console.error('[api/cancel] Could not fetch current availability status:', currentAvailError?.message)
      return Response.json({ error: 'Error cancelling' }, { status: 500 })
    }

    const priorStatus = currentAvail.status

    const { error } = await supabase
      .from('availability')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), court_assignment_status: null })
      .eq('id', availabilityId)
      .eq('player_id', playerId)

    if (error) {
      console.error('[api/cancel] Status update error:', error.message)
      return Response.json({ error: 'Error cancelling' }, { status: 500 })
    }

    console.log(`[api/cancel] Availability ${availabilityId} transitioned to cancelled`)

    const playerName = `${player.first_name} ${player.last_name}`.trim()
    try {
      await handlePostCloseCancellation({
        sessionId,
        cancelledPlayerId: playerId,
        cancelledPlayerName: playerName,
        cancelledPlayerStatus: priorStatus,
        session,
      })
    } catch (err) {
      console.error('[api/cancel] Post-close cancellation handler error:', err)
    }

    return Response.json({ success: true, action: 'cancelled' })

  } else {
    // Session is cancelled or in another non-actionable status.
    // Hard-delete to allow the player to remove themselves cleanly.
    console.log(`[api/cancel] Session status '${session.status}' — hard-deleting availability`)

    const { error } = await supabase
      .from('availability')
      .delete()
      .eq('id', availabilityId)
      .eq('player_id', playerId)

    if (error) {
      console.error('[api/cancel] Hard-delete error:', error.message)
      return Response.json({ error: 'Error cancelling' }, { status: 500 })
    }

    return Response.json({ success: true, action: 'deleted' })
  }
}