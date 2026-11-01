/**
 * lib/day-capacity.js
 *
 * NEW FILE (Oct 30, 2026 — day-level signup).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Symptom (found in the two-week cycle test, Oct 30 2026): on a split-location
 * day (e.g. Wednesday = Memorial Park 2 courts + Boulder Park 1 court), the
 * signup page showed two Wednesday rows. A player who clicked the Boulder row
 * was waitlisted ("This session is full") while Memorial still had 8 open
 * spots. Whether a player got a spot depended on which row they happened to
 * click.
 *
 * Root cause: /api/availability enforced capacity per SESSION record via
 * getSessionRosterCondition({ sessionId }), but the product rule (Automation
 * Logic Section 7) is that players sign up for the DAY and never choose a
 * venue; location is a backend concern resolved at court assignment.
 *
 * Fix, in two parts:
 *   1. Signup: the player picks a day. The server fills that day's open
 *      sessions IN ORDER (largest courts_available first, then lowest id) and
 *      waitlists the player only when EVERY open session that day is full.
 *      See chooseSessionForDaySignup().
 *   2. Waitlist promotion: waitlisted rows for a split day are always parked
 *      on the FIRST session in that same order, but a confirmed player may
 *      later be removed from a DIFFERENT sibling session. The existing
 *      promoteFromWaitlistIfOpenSpot() only looks at waitlisted rows on the
 *      session with the opening, so it would never see the waitlisted player.
 *      rehomeEarliestWaitlistedTo() moves the day's earliest waitlisted row
 *      onto the session with the opening, so the existing promotion logic
 *      (lib/waitlist-promotion.js, unchanged) then works as-is.
 *
 * WHY GREEDY FILL KEEPS PER-SESSION LOGIC CORRECT
 * -----------------------------------------------
 * Filling sessions in order means every session except possibly the LAST one
 * touched is full, and a full session's capacity is a multiple of 4. So the
 * day's total mod 4 equals the one partial session's count mod 4, and the
 * existing per-session logic (Procedure 1, the %4 short checks, reminders)
 * produces the same confirmed/tentative split it would for a pooled day.
 *
 * "OPEN" SIBLING DEFINITION
 * -------------------------
 * Same week_id + same session_date, cancelled_at IS NULL, reminder_sent_at IS
 * NULL. This is the same definition of "open for signup" that
 * app/signup/[token]/page.js already uses to decide which sessions to show.
 *
 * DEPENDENCIES
 * ------------
 * Imports: lib/supabase-admin.js, lib/session-capacity.js
 * Called by: app/api/availability/route.js (POST and DELETE)
 * NOT yet called by (should be, as follow-up — same per-session promotion gap):
 *   app/api/cancel/route.js (POST, status === 'open' branch)
 *   app/api/admin/availability/route.js (DELETE, 'open' branch)
 *
 * Tables read: sessions, availability. Tables written: availability (one
 * UPDATE of session_id on a single waitlisted row, in rehome only).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getSessionRosterCondition } from '@/lib/session-capacity'

/**
 * Returns every session on the same day as the given week/date that is still
 * open for signup, in fill order: largest courts_available first (matches
 * Procedure 2's "largest location first" convention), then lowest id.
 *
 * @param {{ weekId: number|string, sessionDate: string }} args
 *   sessionDate is a bare date string, e.g. "2026-11-04".
 * @returns {Promise<Array<{id:number, week_id:number, session_date:string,
 *   courts_available:number|null}>|null>} Ordered sessions ([] if none open),
 *   or null if the query failed.
 */
export async function getOpenSiblingSessions({ weekId, sessionDate }) {
  console.log(`[day-capacity] getOpenSiblingSessions: week_id=${weekId} session_date=${sessionDate}`)

  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, week_id, session_date, courts_available')
    .eq('week_id', weekId)
    .eq('session_date', sessionDate)
    .is('cancelled_at', null)
    .is('reminder_sent_at', null)

  if (error) {
    console.error('[day-capacity] getOpenSiblingSessions: query error:', error.message)
    return null
  }

  // Sort in JS rather than SQL so the tiebreak rule is visible in one place.
  const ordered = (data ?? []).slice().sort((a, b) => {
    const courtsDiff = (b.courts_available ?? 0) - (a.courts_available ?? 0)
    return courtsDiff !== 0 ? courtsDiff : a.id - b.id
  })

  console.log(`[day-capacity] getOpenSiblingSessions: ${ordered.length} open session(s) found`)
  return ordered
}

/**
 * Decides which session a new day signup lands on, and with what status.
 * Walks the siblings in fill order and takes the first one that is not full.
 * If every sibling is full, the player is waitlisted on the FIRST sibling
 * (the "waitlist home" for the day).
 *
 * Capacity per session comes from getSessionRosterCondition().isFull, so the
 * Mon/Tue anticipated_courts fallback and the >= capacity rule stay in
 * lib/session-capacity.js, where they already live.
 *
 * @param {Array<{id:number}>} siblings - Output of getOpenSiblingSessions().
 * @returns {Promise<{sessionId:number, status:'confirmed'|'waitlisted'}
 *   | {error:string, failedSessionId?:number}>}
 */
export async function chooseSessionForDaySignup(siblings) {
  if (!Array.isArray(siblings) || siblings.length === 0) {
    console.warn('[day-capacity] chooseSessionForDaySignup: no open sessions for this day')
    return { error: 'no_open_sessions' }
  }

  for (const session of siblings) {
    const condition = await getSessionRosterCondition({ sessionId: session.id })

    // null means the roster check itself failed; never guess in that case.
    if (condition === null) {
      console.error(`[day-capacity] chooseSessionForDaySignup: roster condition failed for session_id=${session.id}`)
      return { error: 'roster_condition_failed', failedSessionId: session.id }
    }

    if (!condition.isFull) {
      console.log(`[day-capacity] chooseSessionForDaySignup: session_id=${session.id} has room -> confirmed`)
      return { sessionId: session.id, status: 'confirmed' }
    }
  }

  // Every open session that day is full: waitlist at the day's first session.
  console.log(`[day-capacity] chooseSessionForDaySignup: all ${siblings.length} session(s) full -> waitlisted on session_id=${siblings[0].id}`)
  return { sessionId: siblings[0].id, status: 'waitlisted' }
}

/**
 * Moves the day's earliest waitlisted row (FIFO by created_at) onto the
 * session that just had a confirmed player removed, so the existing
 * promoteFromWaitlistIfOpenSpot() can see and promote them.
 *
 * Call this immediately BEFORE promoteFromWaitlistIfOpenSpot() whenever a
 * confirmed player is removed from an open session. Safe to call on a
 * single-location day (no siblings: returns without changing anything) and
 * safe when no one is waitlisted.
 *
 * The moved row stays 'waitlisted'. If the promotion helper then declines to
 * promote (e.g. the session is still full because the organizer overbooked),
 * the row simply sits waitlisted on the new session, which is harmless.
 *
 * @param {number} sessionId - The session that now has an opening.
 * @returns {Promise<{moved:boolean, reason?:string, availabilityId?:number,
 *   fromSessionId?:number}>}
 */
export async function rehomeEarliestWaitlistedTo(sessionId) {
  console.log(`[day-capacity] rehomeEarliestWaitlistedTo: session_id=${sessionId}`)

  // Look up which day this session belongs to.
  const { data: session, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .select('id, week_id, session_date')
    .eq('id', sessionId)
    .maybeSingle()

  if (sessionError || !session) {
    console.error('[day-capacity] rehomeEarliestWaitlistedTo: could not load session:', sessionError?.message ?? 'not found')
    return { moved: false, reason: 'session_not_found' }
  }

  // Single-location day: nothing to re-home.
  const siblings = await getOpenSiblingSessions({
    weekId: session.week_id,
    sessionDate: session.session_date,
  })
  if (!siblings || siblings.length < 2) {
    console.log('[day-capacity] rehomeEarliestWaitlistedTo: no sibling sessions, nothing to do')
    return { moved: false, reason: 'no_siblings' }
  }

  // Find the day's earliest waitlisted player across ALL open siblings.
  const siblingIds = siblings.map((s) => s.id)
  const { data: waitlisted, error: waitlistError } = await supabaseAdmin
    .from('availability')
    .select('id, session_id, created_at')
    .in('session_id', siblingIds)
    .eq('status', 'waitlisted')
    .order('created_at', { ascending: true })
    .limit(1)

  if (waitlistError) {
    console.error('[day-capacity] rehomeEarliestWaitlistedTo: waitlist query error:', waitlistError.message)
    return { moved: false, reason: 'waitlist_query_failed' }
  }
  if (!waitlisted || waitlisted.length === 0) {
    console.log('[day-capacity] rehomeEarliestWaitlistedTo: no waitlisted players for this day')
    return { moved: false, reason: 'no_waitlist' }
  }

  const earliest = waitlisted[0]

  // Already parked on the session with the opening: promotion can see them.
  if (earliest.session_id === sessionId) {
    console.log('[day-capacity] rehomeEarliestWaitlistedTo: earliest waitlisted row is already on this session')
    return { moved: false, reason: 'already_on_session' }
  }

  // Move the row. The extra status guard avoids touching a row that was
  // promoted or removed by a concurrent request between the select and here.
  const { error: updateError } = await supabaseAdmin
    .from('availability')
    .update({ session_id: sessionId })
    .eq('id', earliest.id)
    .eq('status', 'waitlisted')

  if (updateError) {
    console.error('[day-capacity] rehomeEarliestWaitlistedTo: update error:', updateError.message)
    return { moved: false, reason: 'update_failed' }
  }

  console.log(`[day-capacity] rehomeEarliestWaitlistedTo: moved availability_id=${earliest.id} from session ${earliest.session_id} to session ${sessionId}`)
  return { moved: true, availabilityId: earliest.id, fromSessionId: earliest.session_id }
}