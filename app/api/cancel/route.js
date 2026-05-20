/**
 * /api/cancel
 *
 * Player-facing cancellation route. Called from the cancel page
 * (app/cancel/[token]/[sessionId]/page.js) when a player confirms
 * they want to cancel their spot.
 *
 * Behaviour depends on session status:
 *   - Pre-close (session.status = 'open'): hard-delete the availability
 *     record. No notifications, no sub request logic. Pre-close removals
 *     are quiet and reversible — Phase 2 Section 7.3.
 *   - Post-close (session.status = 'closed'): transition availability to
 *     'cancelled' and trigger post-close cancellation logic (organiser
 *     alert + sub request evaluation) — Phase 2 Section 7.2.
 *
 * No auth session required — player identity is validated via signup_token
 * matching the player record. This is a public route.
 *
 * Tables read:  players, sessions, availability
 * Tables written: availability (delete or status update)
 * Side effects: post-close cancellation triggers lib/sub-requests.js
 */

import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { handlePostCloseCancellation } from '@/lib/sub-requests'

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
  // Pre-close (status = 'open'): hard-delete. No notifications.
  // Post-close (status = 'closed'): status transition + cancellation flow.
  // Other (cancelled session etc.): hard-delete, no downstream effects.
  // ------------------------------------------------------------------
  if (session.status === 'open') {
    // Pre-close: quiet hard-delete.
    console.log(`[api/cancel] Session open — hard-deleting availability ${availabilityId}`)

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
    return Response.json({ success: true, action: 'deleted' })

  } else if (session.status === 'closed') {
    // Post-close: status transition + cancellation flow.
    console.log(`[api/cancel] Session closed — transitioning availability ${availabilityId} to cancelled`)

    const { error } = await supabase
      .from('availability')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', availabilityId)
      .eq('player_id', playerId) // Safety: ensure player only cancels their own record

    if (error) {
      console.error('[api/cancel] Status update error:', error.message)
      return Response.json({ error: 'Error cancelling' }, { status: 500 })
    }

    console.log(`[api/cancel] Availability ${availabilityId} transitioned to cancelled`)

    // Fire post-close cancellation logic asynchronously.
    const playerName = `${player.first_name} ${player.last_name}`.trim()
    handlePostCloseCancellation({
      sessionId,
      cancelledPlayerId: playerId,
      cancelledPlayerName: playerName,
      session,
    }).catch((err) => {
      console.error('[api/cancel] Post-close cancellation handler error:', err)
    })

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