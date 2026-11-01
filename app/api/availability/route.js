/**
 * /api/availability
 *
 * Player-facing availability management. Requires signup_token + player_id
 * validation on every request — no admin auth, no session cookie.
 *
 * ======================================================================
 * THIS REVISION (Oct 30, 2026 — day-level signup)
 * ======================================================================
 * SYMPTOM: on a split-location day (one day, two session records — e.g.
 * Wednesday at Memorial Park and Boulder Park), the signup page showed two
 * rows for the same day, and a player who picked the smaller venue's row was
 * waitlisted ("This session is full") even though the other venue still had
 * room. Found during the two-week cycle test.
 *
 * ROOT CAUSE: POST checked capacity per requested SESSION via
 * getSessionRosterCondition({ sessionId }). But players sign up for the DAY,
 * not a venue (Automation Logic Section 7); which venue they play at is a
 * court-assignment concern. So the per-session check let the click decide
 * who got a spot.
 *
 * FIX (POST): the client now sends ONE session_id per DAY (any session on
 * that day works as a representative). The server resolves that session's
 * open siblings (same week_id + session_date, not cancelled, reminder not
 * sent) via lib/day-capacity.js, fills them in order (largest courts_available
 * first, then lowest id), and waitlists the player only if EVERY sibling is
 * full. The waitlisted row is parked on the day's first session.
 *
 * FIX (DELETE): waitlisted rows live on the day's first session, but a
 * confirmed player may be removed from a different sibling. Before calling
 * promoteFromWaitlistIfOpenSpot() (unchanged, lib/waitlist-promotion.js),
 * rehomeEarliestWaitlistedTo() moves the day's earliest waitlisted row onto
 * the session with the opening so the existing promotion logic can see it.
 *
 * ADDITIONAL HARDENING MADE IN THE SAME PASS (small, flagged so they can be
 * reverted individually if unwanted):
 *   - POST rejects a request for a session whose reminder has already been
 *     sent (reminder_sent_at IS NOT NULL) with a 400. Previously only the
 *     signup PAGE hid such sessions; the route itself did not enforce
 *     "closed to new signups". Sibling selection needs the same open/closed
 *     definition, so enforcing it here keeps the two consistent.
 *   - POST uses the VALIDATED player_id (from body[0]) for every record.
 *     Previously each item's own player_id was spread into the insert, so
 *     items after the first were never token-validated.
 *   - POST is idempotent per day: if the player already has a confirmed,
 *     tentative, or waitlisted row on any open session that day, no second
 *     row is inserted; the existing status is returned instead.
 *   - Insert fields are an explicit whitelist (session_id, player_id,
 *     status) per project convention — no blind spread of client input.
 *
 * KNOWN LIMITATION (pre-existing, not new): capacity is checked and then rows
 * are inserted in separate steps, so two simultaneous signups for the last
 * spot could both be confirmed. Unchanged by this revision.
 *
 * RESPONSE SHAPE: { success: true, results: [{ requested_session_id,
 * session_id, status, already_signed_up? }] }. session_id is the session the
 * player actually landed on; requested_session_id is what the client sent.
 * The client maps results back to days using requested_session_id.
 *
 * ======================================================================
 * PRIOR HISTORY (retained)
 * ======================================================================
 * POST: Player signs up for one or more days. Pre-close signup routing
 *   (Phase 2). Server determines confirmed vs waitlisted status; any
 *   client-supplied status is ignored.
 *
 *   CANCELLED SESSION GUARD: before roster condition checks run, every
 *   targeted session is checked for cancelled_at. If any session in the
 *   request has been cancelled, the entire request is rejected with a 400 —
 *   a player should never be able to sign up for a session the organiser has
 *   cancelled via the session cancellation flow
 *   (app/api/sessions/[sessionId]/cancel).
 *
 * DELETE: Player removes themselves from a session.
 *   PRE-CLOSE WAITLIST PROMOTION (Phase 3 of the unified dynamic waitlist
 *   build): if the removed record's status was 'confirmed' and the session is
 *   still open, checks whether a waitlisted player can now be promoted (see
 *   lib/waitlist-promotion.js). Does NOT apply when the removed player was
 *   themselves 'waitlisted' — that remains a plain deletion per Phase 2
 *   Section 7.5, since removing a waitlisted player frees no confirmed spot.
 *
 *   Organiser IS notified on promotion here (notifyOrganiser: true) — the
 *   organiser had no other visibility into a player-initiated cancellation,
 *   unlike the admin-initiated removal route.
 *
 *   Session status is checked defensively before running promotion logic —
 *   this route is intended to only ever fire pre-close (post-close removal
 *   goes through /api/cancel instead).
 *
 * Tables read:  players (token validation), sessions, availability
 * Tables written: availability (insert, delete, promotion update, waitlist
 *   re-home update)
 *
 * References:
 *   Phase 2 Section 5 — Session Roster Condition (lib/session-capacity.js)
 *   Phase 2 Section 7.2 — (none) → confirmed / (none) → waitlisted transitions
 *   Phase 2 Section 7.3 — Pre-close removal is a record deletion
 *   Phase 2 Section 7.5 — Waitlisted player removal is a record deletion
 *   lib/day-capacity.js — day-level session choice and waitlist re-homing
 *   lib/waitlist-promotion.js — promotion logic and email sends
 *
 * DEPENDENCIES / FOLLOW-UPS
 *   Called by: app/signup/[token]/SignupForm.js (POST and DELETE).
 *   Follow-up: app/api/cancel/route.js (open branch) and
 *   app/api/admin/availability/route.js (DELETE open branch) also call
 *   promoteFromWaitlistIfOpenSpot() per session and have the same split-day
 *   gap; each needs one rehomeEarliestWaitlistedTo(sessionId) call before it.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { promoteFromWaitlistIfOpenSpot } from '@/lib/waitlist-promotion'
import {
  getOpenSiblingSessions,
  chooseSessionForDaySignup,
  rehomeEarliestWaitlistedTo,
} from '@/lib/day-capacity'

/**
 * Confirms the token belongs to this player and the player is active.
 * @param {string} token - players.signup_token
 * @param {number|string} playerId - players.id
 * @returns {Promise<boolean>}
 */
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
  console.log('[api/availability] POST: request received')
  const body = await request.json()

  if (!Array.isArray(body) || body.length === 0) {
    console.warn('[api/availability] POST: invalid request body')
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // Only body[0]'s credentials are validated, so body[0]'s player_id is the
  // one used for every record below (see header: hardening note).
  const { signup_token, player_id } = body[0] || {}
  const valid = await validateToken(signup_token, player_id)
  if (!valid) {
    console.warn('[api/availability] POST: token validation failed')
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Distinct requested session ids, in the order the client sent them.
  const requestedIds = [
    ...new Set(
      body
        .map((item) => item?.session_id)
        .filter((id) => id !== undefined && id !== null)
    ),
  ]
  if (requestedIds.length === 0) {
    console.warn('[api/availability] POST: no session_id values in request')
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // ------------------------------------------------------------------
  // Load the requested sessions (week/date identify the day; cancelled_at
  // and reminder_sent_at drive the guards below).
  // ------------------------------------------------------------------
  const { data: requestedRows, error: sessionFetchError } = await supabaseAdmin
    .from('sessions')
    .select('id, week_id, session_date, cancelled_at, reminder_sent_at')
    .in('id', requestedIds)

  if (sessionFetchError) {
    console.error('[api/availability] POST: error checking session status:', sessionFetchError.message)
    return Response.json({ error: 'Error checking session status' }, { status: 500 })
  }

  if ((requestedRows ?? []).length !== requestedIds.length) {
    console.warn('[api/availability] POST: one or more requested sessions not found')
    return Response.json({ error: 'One or more selected sessions could not be found' }, { status: 400 })
  }

  // CANCELLED SESSION GUARD (retained): reject the whole request if any
  // targeted session has been cancelled.
  const cancelledSessionIds = requestedRows.filter((s) => s.cancelled_at).map((s) => s.id)
  if (cancelledSessionIds.length > 0) {
    console.warn(
      `[api/availability] POST: rejected signup — cancelled session(s) in request: ${cancelledSessionIds.join(', ')}`
    )
    return Response.json(
      { error: 'One or more selected sessions have been cancelled and are closed to signups' },
      { status: 400 }
    )
  }

  // CLOSED SESSION GUARD (new): reminder already sent means closed to new
  // organic signups (Automation Logic Section 2).
  const closedSessionIds = requestedRows.filter((s) => s.reminder_sent_at).map((s) => s.id)
  if (closedSessionIds.length > 0) {
    console.warn(
      `[api/availability] POST: rejected signup — closed session(s) in request: ${closedSessionIds.join(', ')}`
    )
    return Response.json(
      { error: 'One or more selected days are closed to new signups' },
      { status: 400 }
    )
  }

  // ------------------------------------------------------------------
  // Resolve each requested day to a concrete session + status.
  // Processed sequentially; days are independent of each other.
  // ------------------------------------------------------------------
  const rowById = new Map(requestedRows.map((row) => [String(row.id), row]))
  const resultsByDay = new Map() // "week|date" -> { session_id, status, already_signed_up? }
  const recordsToInsert = []
  const results = []

  for (const requestedId of requestedIds) {
    const requested = rowById.get(String(requestedId))
    const dayKey = `${requested.week_id}|${requested.session_date}`

    // Two requested sessions on the same day collapse into one signup.
    if (resultsByDay.has(dayKey)) {
      console.log(`[api/availability] POST: duplicate day in request (session_id=${requested.id}), reusing result`)
      results.push({ requested_session_id: requested.id, ...resultsByDay.get(dayKey) })
      continue
    }

    // Find every open session on this day.
    const siblings = await getOpenSiblingSessions({
      weekId: requested.week_id,
      sessionDate: requested.session_date,
    })
    if (!siblings || siblings.length === 0) {
      console.error(`[api/availability] POST: no open sessions found for requested session_id=${requested.id}`)
      return Response.json({ error: 'Error checking session capacity' }, { status: 500 })
    }

    // Idempotency: already signed up for this day on any open session?
    const siblingIds = siblings.map((s) => s.id)
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from('availability')
      .select('id, session_id, status')
      .eq('player_id', player_id)
      .in('session_id', siblingIds)
      .in('status', ['confirmed', 'tentative', 'waitlisted'])

    if (existingError) {
      console.error('[api/availability] POST: error checking existing signup:', existingError.message)
      return Response.json({ error: 'Error checking existing signup' }, { status: 500 })
    }

    if (existingRows && existingRows.length > 0) {
      const existing = existingRows[0]
      const status = existing.status === 'waitlisted' ? 'waitlisted' : 'confirmed'
      console.log(`[api/availability] POST: player already signed up for this day (status=${existing.status}), no insert`)
      const result = { session_id: existing.session_id, status, already_signed_up: true }
      resultsByDay.set(dayKey, result)
      results.push({ requested_session_id: requested.id, ...result })
      continue
    }

    // Pick the first sibling with room, or waitlist if all are full.
    let choice
    try {
      choice = await chooseSessionForDaySignup(siblings)
    } catch (err) {
      console.error('[api/availability] POST: error choosing session:', err)
      return Response.json({ error: 'Error checking session capacity' }, { status: 500 })
    }
    if (choice.error) {
      console.error(`[api/availability] POST: could not choose session (${choice.error})`)
      return Response.json({ error: 'Error checking session capacity' }, { status: 500 })
    }

    console.log(
      `[api/availability] POST: requested session_id=${requested.id} -> assigned session_id=${choice.sessionId} status=${choice.status}`
    )

    recordsToInsert.push({
      session_id: choice.sessionId,
      player_id,
      status: choice.status,
    })
    const result = { session_id: choice.sessionId, status: choice.status }
    resultsByDay.set(dayKey, result)
    results.push({ requested_session_id: requested.id, ...result })
  }

  // ------------------------------------------------------------------
  // Insert all new rows in one statement (nothing to insert if every day
  // was already signed up).
  // ------------------------------------------------------------------
  if (recordsToInsert.length > 0) {
    const { error } = await supabaseAdmin.from('availability').insert(recordsToInsert)
    if (error) {
      console.error('[api/availability] POST: insert error:', error.message)
      return Response.json({ error: 'Error adding availability' }, { status: 500 })
    }
  }

  console.log(`[api/availability] POST: success — ${recordsToInsert.length} row(s) inserted, ${results.length} day(s) resolved`)
  return Response.json({ success: true, results })
}

export async function DELETE(request) {
  console.log('[api/availability] DELETE: request received')
  const { playerId, sessionIds, availabilityId, signup_token } = await request.json()

  const valid = await validateToken(signup_token, playerId)
  if (!valid) {
    console.warn('[api/availability] DELETE: token validation failed')
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ------------------------------------------------------------------
  // Step 1: Fetch the record(s) being removed, including status, session_id,
  // player name, and the parent session's status/week/date — needed to
  // decide whether promotion logic applies (and to guard against running it
  // post-close). The client now sends EVERY session id for a removed day, so
  // this matches whichever sibling row the player actually holds.
  // ------------------------------------------------------------------
  let recordsToDelete = []

  if (availabilityId) {
    const { data, error } = await supabaseAdmin
      .from('availability')
      .select(`
        id, status, session_id,
        players ( first_name, last_name ),
        sessions ( status, week_id, session_date )
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
        sessions ( status, week_id, session_date )
      `)
      .eq('player_id', playerId)
      .in('session_id', sessionIds)

    if (error) {
      return Response.json({ error: 'Error removing availability' }, { status: 500 })
    }
    recordsToDelete = data ?? []
  }

  console.log(`[api/availability] DELETE: ${recordsToDelete.length} record(s) to remove`)

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
  // is still 'open', check for waitlist promotion. Fire-and-forget — errors
  // are logged and never block the response, consistent with how post-close
  // cancellation handling behaves elsewhere in this codebase.
  //
  // NEW: on a split-location day, first re-home the day's earliest
  // waitlisted row onto THIS session so promoteFromWaitlistIfOpenSpot (which
  // only looks at waitlisted rows on the session it is given) can find them.
  // ------------------------------------------------------------------
  for (const record of recordsToDelete) {
    if (record.status !== 'confirmed') continue
    if (record.sessions?.status !== 'open') continue

    const cancelledPlayerName = `${record.players?.first_name ?? ''} ${record.players?.last_name ?? ''}`.trim()

    try {
      const rehome = await rehomeEarliestWaitlistedTo(record.session_id)
      console.log(
        `[api/availability] DELETE: waitlist re-home for session ${record.session_id}: moved=${rehome.moved}${rehome.reason ? ` (${rehome.reason})` : ''}`
      )

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