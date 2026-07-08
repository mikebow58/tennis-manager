/**
 * /api/availability
 *
 * Player-facing availability management. Requires signup_token + player_id
 * validation on every request — no admin auth, no session cookie.
 *
 * POST: Player signs up for one or more sessions. Pre-close signup routing
 *   (Phase 2) — see file history. Server determines confirmed vs waitlisted
 *   status based on getSessionRosterCondition; client-supplied status is
 *   ignored.
 *
 * DELETE: Player removes themselves from a session.
 *   PRE-CLOSE WAITLIST PROMOTION (added this revision — Phase 3 of the
 *   unified dynamic waitlist build sequence): if the removed record's status
 *   was 'confirmed' and the session is still open, checks whether a
 *   waitlisted player can now be promoted (see lib/waitlist-promotion.js).
 *   Does NOT apply when the removed player was themselves 'waitlisted' —
 *   that remains a plain deletion per Phase 2 Section 7.5, since removing a
 *   waitlisted player frees no confirmed spot.
 *
 *   Organiser IS notified on promotion here (notifyOrganiser: true) — the
 *   organiser had no other visibility into a player-initiated cancellation,
 *   unlike the admin-initiated removal route where they already see the
 *   result directly.
 *
 *   Session status is checked defensively before running promotion logic —
 *   this route is intended to only ever fire pre-close (post-close removal
 *   goes through /api/cancel instead), but no prior version of this file
 *   enforced that at runtime. Added here since promotion logic explicitly
 *   assumes pre-close semantics (Full/waitlist concepts don't apply post-close).
 *
 * Tables read:  players (token validation), sessions, availability
 * Tables written: availability (insert, delete, or promotion update)
 *
 * References:
 *   Phase 2 Section 5 — Session Roster Condition (lib/session-capacity.js)
 *   Phase 2 Section 7.2 — (none) → confirmed / (none) → waitlisted transitions
 *   Phase 2 Section 7.3 — Pre-close removal is a record deletion
 *   Phase 2 Section 7.5 — Waitlisted player removal is a record deletion
 *   lib/waitlist-promotion.js — promotion logic and email sends
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getSessionRosterCondition } from '@/lib/session-capacity'
import { promoteFromWaitlistIfOpenSpot } from '@/lib/waitlist-promotion'

async function validateToken(token, playerId) {
  if (!token || !playerId) return false
  const { data } = await supabaseAdmin
    .from('players')
    .select('id')
    .eq('signup_token', token)
    .eq('id', playerId)
    .eq('active', true)
    .single()
  return !!data
}

export async function POST(request) {
  const body = await request.json()

  if (!Array.isArray(body) || body.length === 0) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { signup_token, player_id } = body[0] || {}
  const valid = await validateToken(signup_token, player_id)
  if (!valid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const sessionIds = body.map((item) => item.session_id)

  let rosterConditions
  try {
    rosterConditions = await Promise.all(
      sessionIds.map((sessionId) => getSessionRosterCondition({ sessionId }))
    )
  } catch (err) {
    console.error('[api/availability] POST: error checking roster conditions:', err)
    return Response.json({ error: 'Error checking session capacity' }, { status: 500 })
  }

  const failedIndex = rosterConditions.findIndex((c) => c === null)
  if (failedIndex !== -1) {
    console.error(
      `[api/availability] POST: roster condition check failed for session_id=${sessionIds[failedIndex]}`
    )
    return Response.json({ error: 'Error checking session capacity' }, { status: 500 })
  }

  const records = body.map(({ signup_token, status: _ignoredClientStatus, ...rest }, i) => ({
    ...rest,
    status: rosterConditions[i].isFull ? 'waitlisted' : 'confirmed',
  }))

  const { error } = await supabaseAdmin
    .from('availability')
    .insert(records)

  if (error) return Response.json({ error: 'Error adding availability' }, { status: 500 })

  const results = records.map((r) => ({
    session_id: r.session_id,
    status: r.status,
  }))

  return Response.json({ success: true, results })
}

export async function DELETE(request) {
  const { playerId, sessionIds, availabilityId, signup_token } = await request.json()

  const valid = await validateToken(signup_token, playerId)
  if (!valid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  // ------------------------------------------------------------------
  // Step 1: Fetch the record(s) being removed, including status, session_id,
  // player name, and the parent session's status — needed both to decide
  // whether promotion logic applies and to guard against running it
  // post-close.
  // ------------------------------------------------------------------
  let recordsToDelete = []

  if (availabilityId) {
    const { data, error } = await supabaseAdmin
      .from('availability')
      .select(`
        id, status, session_id,
        players ( first_name, last_name ),
        sessions ( status )
      `)
      .eq('id', availabilityId)
      .single()

    if (error || !data) {
      return Response.json({ error: 'Error removing availability' }, { status: 500 })
    }
    recordsToDelete = [data]
  } else {
    const { data, error } = await supabaseAdmin
      .from('availability')
      .select(`
        id, status, session_id,
        players ( first_name, last_name ),
        sessions ( status )
      `)
      .eq('player_id', playerId)
      .in('session_id', sessionIds)

    if (error) {
      return Response.json({ error: 'Error removing availability' }, { status: 500 })
    }
    recordsToDelete = data ?? []
  }

  // ------------------------------------------------------------------
  // Step 2: Delete the record(s).
  // ------------------------------------------------------------------
  if (availabilityId) {
    const { error } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('id', availabilityId)
    if (error) return Response.json({ error: 'Error removing availability' }, { status: 500 })
  } else {
    const { error } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('player_id', playerId)
      .in('session_id', sessionIds)
    if (error) return Response.json({ error: 'Error removing availability' }, { status: 500 })
  }

  // ------------------------------------------------------------------
  // Step 3: For each removed record that was 'confirmed' and whose session
  // is still 'open', check for waitlist promotion. Fire-and-forget —
  // errors are logged inside promoteFromWaitlistIfOpenSpot and never block
  // the response, consistent with how post-close cancellation handling
  // behaves elsewhere in this codebase.
  // ------------------------------------------------------------------
  for (const record of recordsToDelete) {
    if (record.status !== 'confirmed') continue
    if (record.sessions?.status !== 'open') continue

    const cancelledPlayerName = `${record.players?.first_name ?? ''} ${record.players?.last_name ?? ''}`.trim()

    try {
      await promoteFromWaitlistIfOpenSpot({
        sessionId: record.session_id,
        cancelledPlayerName,
        notifyOrganiser: true, // player-initiated — organiser had no other visibility
      })
    } catch (err) {
      console.error(
        `[api/availability] DELETE: promotion check failed for session ${record.session_id}:`, err
      )
    }
  }

  return Response.json({ success: true })
}