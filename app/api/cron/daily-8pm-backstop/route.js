/**
 * daily-8pm-backstop — Vercel Cron Job
 *
 * Scheduled: 20:00 MDT daily (02:00 UTC next day, "0 2 * * *" in vercel.json).
 * Derived from admin_settings.court_assignment_deadline (default 20:00).
 * Changing the setting does not auto-reschedule — vercel.json would need updating.
 *
 * PURPOSE (Phase 1 Section 4.9):
 * Hard backstop. Fires unconditionally for any session with unsent assignment
 * details. Does not wait for organizer action.
 *
 * STEP 1 — Auto-send court assignment details:
 *   Query sessions WHERE session_date = tomorrow AND court_assignment_sent_at IS NULL
 *   AND status = 'closed' AND cancelled_at IS NULL.
 *   Deduplicate by week_id + session_date (multi-location days processed once).
 *   For each day: read court_assignments to determine whether court numbers are set.
 *     - All courts have court_number: send full details including court number
 *       (sendCourtAssignmentDetailsFull).
 *     - Any court missing court_number: send session details only with
 *       "court assignment will be posted at the courts" message
 *       (sendCourtAssignmentDetails).
 *   Set sessions.court_assignment_sent_at = now() on all sibling sessions.
 *
 * STEP 2 — Auto-cancel incomplete courts:
 *   For each session from Step 1: find players with status = 'tentative'.
 *   If any: set their availability.status → 'cancelled', cancelled_at = now(),
 *   court_assignment_status = null.
 *   Send court cancellation notices to those players (batch).
 *   Alert the organizer simultaneously.
 *
 *   BUG FIX (dev session Sep 1, 2026): the update now also sets
 *   cancellation_reason = 'court_not_filled'. Previously this wrote plain
 *   status = 'cancelled', identical to a real player cancellation or
 *   organizer removal — the admin dashboard's cancellation count
 *   (app/page.js) was counting these court-didn't-fill releases as
 *   cancellations, which they are not. The court-assignment approve route
 *   (/api/admin/court-assignment/[sessionID]/approve) sets the same reason
 *   value when the organizer manually cancels an incomplete court before
 *   8pm — both represent the same underlying event. See migration
 *   20260901000000_add_cancellation_reason.sql.
 *
 * STEP 3 — Nothing to do:
 *   If Step 1 returns 0 rows: exit cleanly. All assignments already sent
 *   (organizer approved before 8pm).
 *
 * REVISION (Oct 30, 2026 — split-location day sweep):
 *   WHAT IS AND ISN'T A "GUESS." The venue on the full-details and the
 *   details-only (court_number missing) branches comes from each player's
 *   own court_assignments row — the venue Procedure 2 actually assigned
 *   that player to — so it is post-assignment information and is unchanged
 *   in meaning. Two places were pre-assignment guesses and are fixed:
 *   1. AVAILABILITY FALLBACK (no court_assignments at all). SYMPTOM: on a
 *      split-location day the fallback email named the first session
 *      record's venue (primarySession.locations.name, falling back to
 *      "TBD") for every player, even though players were never assigned
 *      to venues. ROOT CAUSE: it reused one arbitrary session's venue for
 *      the whole day. FIX: venue now comes from getVenueForEmail on the
 *      first session of the day — null on a split day, the real venue on a
 *      single-session day. sendCourtAssignmentDetails omits the Location
 *      row and says the location will be confirmed separately when null.
 *      NOTE: if this fallback ever runs on a split day, players get no
 *      venue and the organizer is not alerted by this cron; a warning is
 *      logged. Procedure 2 normally runs at 6pm, so this should only occur
 *      if it failed.
 *   2. ORGANIZER BACKSTOP ALERT. It used session.locations.name (the first
 *      pending session's venue, or "TBD"). Now getVenueForEmail(session.id),
 *      so it names the venue only on single-session days.
 *   Also: the details-only branch no longer falls back to "TBD" when a
 *   court_assignments row has no location (it passes null, and the email
 *   omits the venue). The tentative cancellation-notice payload no longer
 *   carries locationName (sendCourtCancellationNotice never rendered it).
 *   The `locations` joins on the session selects were dropped where no
 *   longer used. The full-details branch still falls back to "TBD" for a
 *   missing assigned venue, since sendCourtAssignmentDetailsFull always
 *   prints a Location row; left unchanged (post-assignment, edge case).
 *
 * Tables read:   sessions, availability, players, locations (via
 *                court_assignments join), court_assignments, weeks (join)
 * Tables written: sessions (court_assignment_sent_at),
 *                 availability (status → 'cancelled', cancelled_at,
 *                               cancellation_reason → 'court_not_filled',
 *                               court_assignment_status → null)
 * Emails sent:
 *   - sendCourtAssignmentDetailsFull — confirmed players when court numbers set
 *   - sendCourtAssignmentDetails     — confirmed players when court numbers missing
 *   - sendCourtCancellationNotice    — tentative players (batch, per session)
 *   - sendBackstopCancellationAlert  — organizer (per session with cancellations)
 *
 * PRIOR REVISION (Sept 2026 session — Player page build):
 *   All three places that build a confirmed player's `cancelUrl` had the
 *   same independent bug: they pointed at `/portal/${signup_token}`, but
 *   the intended action is a per-session CANCEL, which needs
 *   `/cancel/${signup_token}/${sessionId}` (confirmed correct usage
 *   elsewhere in this codebase — see lib/sub-requests.js). Fixed in all
 *   three: the court_assignments-based full-details branch, the
 *   session-details-only branch, and the availability-fallback branch.
 *   The fallback branch's `confirmedAvail` query previously didn't select
 *   `session_id` at all — added, since it's now required to build the
 *   corrected cancelUrl (a day can have sibling sessions, so player
 *   session_id can't be assumed to equal the outer `session.id`).
 *   playerPageUrl (`/signup/${signup_token}` — the permanent Player page)
 *   added throughout, including on the tentative cancellation-notice
 *   payload, which previously had no link at all.
 *
 * References:
 *   Phase 1 Cron Map — Section 4.9
 *   Phase 2 State Machines — Section 4.5 (Procedure 2), Section 7.2
 *   Phase 3 Cross-Lifecycle — Group 5 (8pm backstop fires)
 *   Automation Logic — Section 8.2 (Path B backstop)
 *   Oct 30, 2026 state handoff — split-location day governing rule
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendCourtAssignmentDetailsFull,
  sendCourtAssignmentDetails,
  sendCourtCancellationNotice,
  sendBackstopCancellationAlert,
} from '@/lib/email'
import { getAdminEmail } from '@/lib/admin-settings'
import { getVenueForEmail } from '@/lib/day-capacity'

export async function GET(request) {
  const startTime = Date.now()
  console.log('[daily-8pm-backstop] Cron fired at', new Date().toISOString())

  // ------------------------------------------------------------------
  // Guard: verify request is from Vercel's cron scheduler.
  // ------------------------------------------------------------------
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[daily-8pm-backstop] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // ------------------------------------------------------------------
  // Establish tomorrow's date in Mountain Time.
  // ------------------------------------------------------------------
  const nowUtc = new Date()

  function toMountainDateStr(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }

  const tomorrowDate = new Date(nowUtc)
  tomorrowDate.setUTCDate(nowUtc.getUTCDate() + 1)
  const tomorrowStr = toMountainDateStr(tomorrowDate)

  console.log('[daily-8pm-backstop] Processing sessions for tomorrow:', tomorrowStr)

  const adminEmail = await getAdminEmail()
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

  if (!adminEmail) {
    console.error('[daily-8pm-backstop] ADMIN_EMAIL not set — organizer alerts will not send')
  }

  // ------------------------------------------------------------------
  // STEP 1: Query sessions that still need court assignment details sent.
  // court_assignment_sent_at IS NULL = backstop hasn't already fired
  // and organizer hasn't approved (idempotency guard).
  // ------------------------------------------------------------------
  const { data: pendingSessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      session_date,
      start_time,
      week_id,
      courts_available,
      notes,
      weeks!inner ( status )
    `)
    .eq('session_date', tomorrowStr)
    .eq('status', 'closed')
    .is('cancelled_at', null)
    .is('court_assignment_sent_at', null)
    .eq('weeks.status', 'sent')

  if (sessionsError) {
    console.error('[daily-8pm-backstop] Error querying pending sessions:', sessionsError.message)
    return new Response(
      JSON.stringify({ status: 'error', message: sessionsError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // ------------------------------------------------------------------
  // STEP 3 check: nothing to do if all assignments already sent.
  // ------------------------------------------------------------------
  if (pendingSessions.length === 0) {
    console.log(
      '[daily-8pm-backstop] No pending sessions — all assignments already sent before 8pm. Exiting.'
    )
    const elapsed = Date.now() - startTime
    return new Response(
      JSON.stringify({ status: 'ok', outcome: { sessionsProcessed: 0 }, elapsedMs: elapsed }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  console.log(`[daily-8pm-backstop] Found ${pendingSessions.length} session(s) to process.`)

  // Deduplicate by week_id + session_date so multi-location days are
  // processed once. We'll resolve all sibling sessions per day below.
  const processedDays = new Set()
  let sessionsProcessed = 0
  let totalConfirmedNotified = 0
  let totalTentativeCancelled = 0

  for (const session of pendingSessions) {
    const dayKey = `${session.week_id}:${session.session_date}`
    if (processedDays.has(dayKey)) {
      console.log(`[daily-8pm-backstop] Day ${dayKey} already processed — skipping sibling session ${session.id}.`)
      continue
    }
    processedDays.add(dayKey)

    // ------------------------------------------------------------------
    // Resolve all sibling sessions for this day (multi-location support).
    // ------------------------------------------------------------------
    const { data: daySessions, error: dayError } = await supabaseAdmin
      .from('sessions')
      .select('id, start_time, notes')
      .eq('week_id', session.week_id)
      .eq('session_date', session.session_date)
      .eq('status', 'closed')
      .is('cancelled_at', null)

    if (dayError || !daySessions?.length) {
      console.error(`[daily-8pm-backstop] Could not resolve day sessions for ${dayKey}:`, dayError?.message)
      continue
    }

    const sessionIds = daySessions.map((s) => s.id)
    const sessionDateLabel = formatSessionDateLabel(session.session_date)

    console.log(`[daily-8pm-backstop] Processing day ${dayKey} — ${sessionIds.length} session(s).`)

    // ------------------------------------------------------------------
    // Oct 30, 2026: day-level venue for the pre-assignment guesses below
    // (availability fallback + organizer alert). null on a split-location
    // day or lookup error. Resolved once per day via the first pending
    // session; getVenueForEmail counts the whole day's sessions, so any
    // sibling gives the same answer.
    // ------------------------------------------------------------------
    const { locationName: dayLocationName, isSplitDay } = await getVenueForEmail(session.id)

    // ------------------------------------------------------------------
    // Read court_assignments for all confirmed players across all sessions
    // for this day. Used to determine email type and build payloads.
    // ------------------------------------------------------------------
    const { data: confirmedAssignments, error: caReadError } = await supabaseAdmin
      .from('court_assignments')
      .select(`
        court_number,
        court_letter,
        session_id,
        location_id,
        players ( id, first_name, last_name, email, signup_token ),
        locations ( name )
      `)
      .in('session_id', sessionIds)
      .eq('assignment_status', 'confirmed')

    if (caReadError) {
      console.error(
        `[daily-8pm-backstop] Error reading court_assignments for day ${dayKey}:`,
        caReadError.message
      )
      // Fall through to availability-based send (no court details).
    }

    // ------------------------------------------------------------------
    // Determine whether we have court numbers for all confirmed players.
    // If any are missing, fall back to session-details-only email.
    // ------------------------------------------------------------------
    const hasCourtAssignments = confirmedAssignments?.length > 0
    const allHaveCourtNumbers = hasCourtAssignments &&
      confirmedAssignments.every((a) => a.court_number != null)

    if (hasCourtAssignments) {
      if (allHaveCourtNumbers) {
        // Full details — court number included in email. The venue is each
        // player's own assigned venue from court_assignments (post-
        // assignment — unchanged).
        // BUG FIX (Sept 2026 — Player page build): cancelUrl was
        // `/portal/${signup_token}`, which is not a cancel action.
        // Corrected to the real per-session cancel route. playerPageUrl
        // added for the new bookmark footer link.
        const emailPayloads = confirmedAssignments.map((a) => {
          const playerSession = daySessions.find((s) => s.id === a.session_id)
          return {
            playerFirstName: a.players.first_name,
            playerEmail: a.players.email,
            sessionDate: sessionDateLabel,
            startTime: formatStartTime(playerSession?.start_time),
            locationName: a.locations?.name ?? 'TBD',
            courtNumber: a.court_number,
            notes: playerSession?.notes ?? null,
            cancelUrl: `${baseUrl}/cancel/${a.players.signup_token}/${a.session_id}`,
            playerPageUrl: `${baseUrl}/signup/${a.players.signup_token}`,
          }
        })

        console.log(
          `[daily-8pm-backstop] Sending full court assignment details (with court numbers) ` +
          `to ${emailPayloads.length} confirmed player(s).`
        )

        const { sent, failed } = await sendCourtAssignmentDetailsFull(emailPayloads)
        console.log(`[daily-8pm-backstop] Day ${dayKey} — assignment emails: sent=${sent} failed=${failed}.`)
        totalConfirmedNotified += sent

      } else {
        // Court numbers not fully set — session details only. The venue is
        // still each player's own assigned venue from court_assignments;
        // Oct 30: if a row has none, pass null (the email omits the venue)
        // instead of the literal text "TBD".
        // BUG FIX (Sept 2026 — Player page build): same cancelUrl fix as
        // the full-details branch above.
        const emailPayloads = confirmedAssignments.map((a) => {
          const playerSession = daySessions.find((s) => s.id === a.session_id)
          return {
            playerFirstName: a.players.first_name,
            playerEmail: a.players.email,
            sessionDate: sessionDateLabel,
            startTime: formatStartTime(playerSession?.start_time),
            locationName: a.locations?.name ?? null,
            notes: playerSession?.notes ?? null,
            cancelUrl: `${baseUrl}/cancel/${a.players.signup_token}/${a.session_id}`,
            playerPageUrl: `${baseUrl}/signup/${a.players.signup_token}`,
          }
        })

        console.log(
          `[daily-8pm-backstop] Court numbers not fully set — sending session-details-only email ` +
          `to ${emailPayloads.length} confirmed player(s).`
        )

        const { sent, failed } = await sendCourtAssignmentDetails(emailPayloads)
        console.log(`[daily-8pm-backstop] Day ${dayKey} — assignment emails: sent=${sent} failed=${failed}.`)
        totalConfirmedNotified += sent
      }

    } else {
      // No court_assignments records at all (Procedure 2 never ran or failed).
      // Fall back to availability-based confirmed player query.
      console.warn(
        `[daily-8pm-backstop] No court_assignments found for day ${dayKey} — ` +
        `falling back to availability query. Procedure 2 may not have run.`
      )
      if (isSplitDay) {
        console.warn(
          `[daily-8pm-backstop] Day ${dayKey} is a split-location day with no court assignments — ` +
          `fallback emails will carry NO venue, and the organizer is not alerted by this cron. ` +
          `Manual follow-up with players is required.`
        )
      }

      // BUG FIX (Sept 2026 — Player page build): session_id added to this
      // select. It wasn't previously selected at all, so the fallback
      // branch had no way to build a correct per-session cancelUrl (a day
      // can have multiple sibling sessions — session_id can't be assumed
      // to equal the outer `session.id`).
      const { data: confirmedAvail, error: confirmedAvailError } = await supabaseAdmin
        .from('availability')
        .select(`
          id,
          session_id,
          players ( first_name, last_name, email, signup_token )
        `)
        .in('session_id', sessionIds)
        .eq('status', 'confirmed')

      if (confirmedAvailError) {
        console.error(
          `[daily-8pm-backstop] Error fetching confirmed availability for day ${dayKey}:`,
          confirmedAvailError.message
        )
      } else if (confirmedAvail?.length > 0) {
        // Use first session's details for the fallback email (start time,
        // notes) — but each player's cancelUrl uses their own actual
        // session_id, not the primary session's, for correctness on
        // multi-location days. Venue: dayLocationName (null on split days).
        const primarySession = daySessions[0]

        const emailPayloads = confirmedAvail.map((a) => ({
          playerFirstName: a.players.first_name,
          playerEmail: a.players.email,
          sessionDate: sessionDateLabel,
          startTime: formatStartTime(primarySession?.start_time),
          locationName: dayLocationName,
          notes: primarySession?.notes ?? null,
          cancelUrl: `${baseUrl}/cancel/${a.players.signup_token}/${a.session_id}`,
          playerPageUrl: `${baseUrl}/signup/${a.players.signup_token}`,
        }))

        const { sent, failed } = await sendCourtAssignmentDetails(emailPayloads)
        console.log(
          `[daily-8pm-backstop] Day ${dayKey} — fallback assignment emails: sent=${sent} failed=${failed}.`
        )
        totalConfirmedNotified += sent
      }
    }

    // ------------------------------------------------------------------
    // Set court_assignment_sent_at on all sibling sessions.
    // Do this before processing tentative cancellations so the session
    // is marked as actioned even if the tentative step encounters an error.
    // ------------------------------------------------------------------
    const { error: sentAtError } = await supabaseAdmin
      .from('sessions')
      .update({ court_assignment_sent_at: new Date().toISOString() })
      .in('id', sessionIds)

    if (sentAtError) {
      console.error(
        `[daily-8pm-backstop] CRITICAL — failed to set court_assignment_sent_at for day ${dayKey}:`,
        sentAtError.message
      )
    } else {
      console.log(`[daily-8pm-backstop] court_assignment_sent_at set for day ${dayKey}.`)
    }

    sessionsProcessed++

    // ------------------------------------------------------------------
    // STEP 2: Auto-cancel incomplete courts.
    // Find all tentative players across all sessions for this day.
    // ------------------------------------------------------------------
    const { data: tentativeAvail, error: tentativeError } = await supabaseAdmin
      .from('availability')
      .select(`
        id,
        session_id,
        players ( first_name, last_name, email, signup_token )
      `)
      .in('session_id', sessionIds)
      .eq('status', 'tentative')

    if (tentativeError) {
      console.error(
        `[daily-8pm-backstop] Error fetching tentative players for day ${dayKey}:`,
        tentativeError.message
      )
      continue
    }

    if (tentativeAvail.length === 0) {
      console.log(`[daily-8pm-backstop] Day ${dayKey} — no tentative players. No auto-cancel needed.`)
      continue
    }

    console.log(
      `[daily-8pm-backstop] Day ${dayKey} — auto-cancelling ${tentativeAvail.length} tentative player(s).`
    )

    // Transition all tentative records to cancelled.
    const tentativeIds = tentativeAvail.map((a) => a.id)

    const { error: cancelError } = await supabaseAdmin
      .from('availability')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        court_assignment_status: null,
        // BUG FIX (dev session Sep 1, 2026): distinguishes a court-never-
        // filled auto-release from a real player cancellation or organizer
        // removal. See migration 20260901000000_add_cancellation_reason.sql.
        cancellation_reason: 'court_not_filled',
      })
      .in('id', tentativeIds)

    if (cancelError) {
      console.error(
        `[daily-8pm-backstop] Error cancelling tentative availability for day ${dayKey}:`,
        cancelError.message
      )
      console.error(
        `[daily-8pm-backstop] WARNING: DB write failed but proceeding with player notifications. ` +
        `Day ${dayKey} may have orphaned tentative records — manual review required.`
      )
    } else {
      console.log(
        `[daily-8pm-backstop] ${tentativeAvail.length} tentative record(s) set to cancelled for day ${dayKey}.`
      )
      totalTentativeCancelled += tentativeAvail.length
    }

    // Send cancellation notices to the tentative players (batch).
    // PRIOR REVISION: playerPageUrl added — this email previously had no
    // link at all. Oct 30: locationName removed from this payload —
    // sendCourtCancellationNotice never rendered it.
    const tentativeEmailPayloads = tentativeAvail.map((a) => {
      const playerSession = daySessions.find((s) => s.id === a.session_id)
      return {
        playerFirstName: a.players.first_name,
        playerEmail: a.players.email,
        sessionDate: sessionDateLabel,
        startTime: formatStartTime(playerSession?.start_time),
        playerPageUrl: `${baseUrl}/signup/${a.players.signup_token}`,
      }
    })

    const { sent: cancelSent, failed: cancelFailed } =
      await sendCourtCancellationNotice(tentativeEmailPayloads)

    console.log(
      `[daily-8pm-backstop] Day ${dayKey} — cancellation notices: ` +
      `sent=${cancelSent} failed=${cancelFailed}.`
    )

    // Alert the organizer simultaneously. Oct 30: venue is the day-level
    // value (null on split-location days).
    if (adminEmail) {
      const cancelledPlayerNames = tentativeAvail.map(
        (a) => `${a.players.first_name} ${a.players.last_name}`
      )
      const confirmedCount = confirmedAssignments?.length ?? 0

      await sendBackstopCancellationAlert({
        adminEmail,
        sessionDateLabel,
        locationName: dayLocationName,
        cancelledCourtPlayerCount: tentativeAvail.length,
        confirmedCount,
        cancelledPlayerNames,
      }).catch((err) =>
        console.error(
          `[daily-8pm-backstop] Failed to send organizer alert for day ${dayKey}:`, err
        )
      )
    }
  }

  const elapsed = Date.now() - startTime
  const outcome = {
    sessionsProcessed,
    totalConfirmedNotified,
    totalTentativeCancelled,
  }
  console.log(`[daily-8pm-backstop] Complete in ${elapsed}ms.`, JSON.stringify(outcome))

  return new Response(
    JSON.stringify({ status: 'ok', outcome, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function formatSessionDateLabel(sessionDate) {
  const date = new Date(sessionDate + 'T12:00:00Z')
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

function formatStartTime(startTime) {
  if (!startTime) return 'TBD'
  return new Date(`1970-01-01T${startTime}Z`).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
  })
}