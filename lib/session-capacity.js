/**
 * lib/session-capacity.js
 *
 * Shared utility for computing PRE-CLOSE session roster condition — Full,
 * Short, and Waitlist Mode, per Phase 2 Section 5 (Session Roster Condition).
 *
 * IMPORTANT SCOPE BOUNDARY — READ BEFORE USING:
 * This file covers PRE-CLOSE roster condition only (session.status = 'open').
 * Pre-close "short" means confirmed_count % 4 !== 0 (not enough players to
 * form complete courts yet). This is a completely different concept from
 * POST-CLOSE "short" (incomplete courts after Procedure 1/2 has run, driven
 * by availability.court_assignment_status = 'tentative' counts). Phase 2
 * Section 5.4 is explicit that these two concepts must not be conflated in
 * implementation. Do not use this file to determine post-close sub request
 * need — that logic lives in lib/sub-requests.js and is based on tentative
 * counts, not this file's isFull/isShortPreClose/waitlistMode values.
 *
 * Capacity trigger definition (Phase 2 Section 5.2):
 *   Wed–Sat: sessions.courts_available * 4
 *   Mon/Tue: sessions.anticipated_courts * 4, falling back to
 *            courts_available * 4 if anticipated_courts is NULL (not a hard
 *            block — the system never blocks the organiser; a low-priority
 *            dashboard indicator is the intended nudge, not implemented here).
 *
 * Waitlist scope note (resolved this session — see handoff): the dedicated
 * `waitlist` table has been dropped. Waitlisted players are rows in
 * `availability` with status = 'waitlisted', per Phase 2 Section 7.1/7.2 and
 * Phase 3 Group 3. getSessionRosterCondition() below queries availability
 * for this status directly. There is no separate waitlist table to join.
 *
 * References:
 *   Phase 2 Section 5 — Session Roster Condition (full spec for this file)
 *   Phase 2 Section 5.2 — Capacity Trigger Definition
 *   Phase 2 Section 5.4 — Pre-Close vs Post-Close Short (scope boundary above)
 *   Phase 2 Section 7.1 — availability.status = 'waitlisted' definition
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Pure function — no DB access. Computes the capacity trigger for a single
 * session record given its day of week and court-count fields.
 *
 * @param {object} session
 * @param {string} session.session_date      - 'YYYY-MM-DD'
 * @param {number|null} session.courts_available
 * @param {number|null} session.anticipated_courts - Mon/Tue only; may be null
 * @returns {{ capacityTrigger: number, usingFallbackCapacity: boolean }}
 */
export function getCapacityTrigger(session) {
  const sessionDate = new Date(session.session_date + 'T12:00:00Z')
  const dayOfWeek = sessionDate.getUTCDay() // 0=Sun ... 6=Sat
  const isMonOrTue = dayOfWeek === 1 || dayOfWeek === 2

  const courtsAvailable = session.courts_available ?? 0

  if (!isMonOrTue) {
    // Wed–Sat: always driven by courts_available.
    return {
      capacityTrigger: courtsAvailable * 4,
      usingFallbackCapacity: false,
    }
  }

  // Mon/Tue: prefer anticipated_courts. Fall back to courts_available if
  // anticipated_courts is null — not a hard block, just a fallback with a
  // flag so callers can surface a nudge if they choose to.
  if (session.anticipated_courts != null) {
    return {
      capacityTrigger: session.anticipated_courts * 4,
      usingFallbackCapacity: false,
    }
  }

  return {
    capacityTrigger: courtsAvailable * 4,
    usingFallbackCapacity: true,
  }
}

/**
 * Fetches the session record and current availability counts, then computes
 * the full pre-close roster condition. This function does its own DB fetch —
 * callers pass a sessionId, not pre-loaded data. If a call site already has
 * the session record and counts loaded (e.g. a cron processing many sessions
 * in a loop), this will re-fetch rather than reuse that data; this tradeoff
 * was chosen deliberately to keep call sites simple, since the two known
 * initial callers (signup route, future Full-status checks) do not have this
 * data loaded already.
 *
 * @param {object} params
 * @param {string|number} params.sessionId
 * @returns {Promise<{
 *   confirmedCount: number,
 *   waitlistedCount: number,
 *   capacityTrigger: number,
 *   usingFallbackCapacity: boolean,
 *   isFull: boolean,
 *   isShortPreClose: boolean,
 *   spotsOpen: number,
 *   waitlistMode: boolean,
 * } | null>} null if the session record could not be fetched
 */
export async function getSessionRosterCondition({ sessionId }) {
  const { data: session, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .select('id, session_date, courts_available, anticipated_courts')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    console.error(
      `[session-capacity] getSessionRosterCondition: failed to fetch session ${sessionId}:`,
      sessionError?.message
    )
    return null
  }

  const { data: availabilityRows, error: availError } = await supabaseAdmin
    .from('availability')
    .select('status')
    .eq('session_id', sessionId)
    .in('status', ['confirmed', 'waitlisted'])

  if (availError) {
    console.error(
      `[session-capacity] getSessionRosterCondition: failed to fetch availability for session ${sessionId}:`,
      availError.message
    )
    return null
  }

  const confirmedCount = availabilityRows.filter((a) => a.status === 'confirmed').length
  const waitlistedCount = availabilityRows.filter((a) => a.status === 'waitlisted').length

  const { capacityTrigger, usingFallbackCapacity } = getCapacityTrigger(session)

  // Full uses >= rather than = — organiser manual adds can push
  // confirmed_count above capacity. Phase 2 Section 5.6 (Resolved).
  const isFull = confirmedCount >= capacityTrigger

  // Pre-close short: confirmed_count % 4 !== 0. Only meaningful while
  // session.status = 'open' — see file header scope boundary.
  const isShortPreClose = confirmedCount % 4 !== 0

  const spotsOpen = Math.max(0, capacityTrigger - confirmedCount)

  // waitlist_mode: full AND at least one waitlisted player exists.
  // A full session with no waitlisted players is full, not waitlist_mode.
  // Phase 2 Section 5.1.
  const waitlistMode = isFull && waitlistedCount > 0

  console.log(
    `[session-capacity] session=${sessionId} confirmedCount=${confirmedCount} ` +
    `waitlistedCount=${waitlistedCount} capacityTrigger=${capacityTrigger} ` +
    `(fallback=${usingFallbackCapacity}) isFull=${isFull} ` +
    `isShortPreClose=${isShortPreClose} waitlistMode=${waitlistMode}`
  )

  return {
    confirmedCount,
    waitlistedCount,
    capacityTrigger,
    usingFallbackCapacity,
    isFull,
    isShortPreClose,
    spotsOpen,
    waitlistMode,
  }
}