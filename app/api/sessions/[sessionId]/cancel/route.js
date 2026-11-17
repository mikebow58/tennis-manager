// app/api/sessions/[sessionId]/cancel/route.js
//
// POST /api/sessions/[sessionId]/cancel — cancels a session in place. This
// is the organizer's simplified cancellation design (Option D, agreed in
// an earlier session — see Project Summary Section 21 "Session cancellation
// reason" for the original, larger-scope spec this replaces):
//
//   - Sets sessions.cancelled_at + sessions.cancellation_note (optional
//     freeform reason). Does NOT introduce a 'cancelled' value into
//     sessions.status, and does NOT delete the session or its availability
//     records — deliberately simpler than the original Phase 2 cancel/
//     reinstate state machine, which this does not implement.
//   - Closes any active sub_requests row for this session (no filled_at —
//     the spot wasn't filled, the session was cancelled out from under it).
//   - Emails CONFIRMED players only, with the optional reason included.
//     Tentative and waitlisted players are NOT emailed — organizer decision:
//     they've already been told their status is provisional and aren't
//     expecting to play unless/until told otherwise, so a cancellation
//     notice would be redundant.
//
// Every relevant cron (daily-8am Check B, daily-5pm-escalation,
// daily-6pm-court-assignment, daily-8pm-backstop) already filters on
// `cancelled_at IS NULL`, so setting this one field is sufficient to make
// the entire automated pipeline correctly skip this session — no cron
// changes needed.
//
// Callers must independently ensure new signups are rejected against a
// cancelled session — see the cancelled_at guards in
// app/api/availability/route.js (player-facing) and
// app/api/admin/availability/route.js (organizer manual add). This route
// does not itself prevent future signups; it only marks the session and
// notifies existing confirmed players.
//
// REVISION (Oct 30, 2026 — split-location day sweep; design decision made
// with Mikel: "option 1, day-level wording"):
//   SYMPTOM: the cancellation notice said "your tennis session on <date> at
//   <venue> has been cancelled" (venue falling back to the literal text
//   "TBD") even on a split-location day, where players signed up for the
//   DAY and were never told which venue their session record was at.
//   DECISION: when the organizer cancels one session on a split day, only
//   the confirmed players on THAT session record are notified (exactly as
//   before — this route only ever notified the cancelled session's own
//   confirmed players), and the wording is day-level with no venue.
//   FIX: venue now comes from getVenueForEmail(sessionId)
//   (lib/day-capacity.js), which returns null on split days and on any
//   query error; sendSessionCancellationNotice omits the "at <venue>"
//   wording when null. The `locations ( name )` join is dropped and the
//   '?? "TBD"' fallback is removed on purpose. Single-session days are
//   unchanged (the venue is still named).
//   ORDERING MATTERS: getVenueForEmail decides "split day" by counting the
//   day's NON-CANCELLED sessions. This route sets cancelled_at in Step 2,
//   so the venue MUST be resolved BEFORE that write — afterwards, a split
//   day with one session cancelled would look like a single-session day and
//   the notice would name a venue. That is why the lookup is in Step 1.
//   KNOWN CAVEAT (not changed): a player on the cancelled record is told
//   their session is cancelled even though the sibling session for the same
//   day is still running, and this route does not move them there. The
//   organizer can add them to the sibling via the admin UI if wanted.
//
// PRIOR REVISION (Sept 2026 session — Player page build): signup_token is
// selected for the confirmed players below so each recipient can get a
// playerPageUrl (`/signup/${token}` — the permanent Player page, per
// organizer decision), rendered as a bookmark-style footer link by
// lib/email.js's shared buildFooterHtml() helper.
//
// Tables read:  sessions, availability, sub_requests
// Tables written: sessions (cancelled_at, cancellation_note),
//   sub_requests (status → closed, active rows only)

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendSessionCancellationNotice } from '@/lib/email'
import { getVenueForEmail } from '@/lib/day-capacity'

export async function POST(request, { params }) {
  const { sessionId } = await params

  let body = {}
  try {
    body = await request.json()
  } catch {
    // No body sent — treat as "no reason given", not an error.
  }
  const cancellationNote =
    typeof body.cancellationNote === 'string' ? (body.cancellationNote.trim() || null) : null

  console.log(`[api/sessions/${sessionId}/cancel] POST — cancellationNote=${cancellationNote ? 'provided' : 'none'}`)

  // ------------------------------------------------------------------
  // Step 1: Fetch the session. Guard against double-cancellation.
  // ------------------------------------------------------------------
  const { data: session, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .select('id, session_date, start_time, cancelled_at')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    console.error(`[api/sessions/${sessionId}/cancel] session fetch error:`, sessionError?.message)
    return Response.json({ error: 'Session not found' }, { status: 404 })
  }

  if (session.cancelled_at) {
    console.warn(`[api/sessions/${sessionId}/cancel] already cancelled at ${session.cancelled_at} — rejecting`)
    return Response.json({ error: 'Session is already cancelled' }, { status: 400 })
  }

  // Oct 30, 2026: resolve the venue for the notice NOW, before Step 2
  // marks this session cancelled — see "ORDERING MATTERS" in the file
  // header. null on split-location days or lookup error.
  const { locationName } = await getVenueForEmail(sessionId)

  // ------------------------------------------------------------------
  // Step 2: Mark the session cancelled. This is the field every cron
  // already filters on — this single write is what makes the automated
  // pipeline correctly skip this session going forward.
  // ------------------------------------------------------------------
  const { error: updateError } = await supabaseAdmin
    .from('sessions')
    .update({
      cancelled_at: new Date().toISOString(),
      cancellation_note: cancellationNote,
    })
    .eq('id', sessionId)

  if (updateError) {
    console.error(`[api/sessions/${sessionId}/cancel] update error:`, updateError.message)
    return Response.json({ error: 'Error cancelling session' }, { status: 500 })
  }

  // ------------------------------------------------------------------
  // Step 3: Close any active sub_requests row for this session. A player
  // could otherwise still confirm/decline a fill-in spot on a session that
  // no longer exists in any practical sense. No filled_at is set — the
  // spot was never filled, the session was cancelled out from under it.
  // ------------------------------------------------------------------
  const { error: subCloseError } = await supabaseAdmin
    .from('sub_requests')
    .update({ status: 'closed' })
    .eq('session_id', sessionId)
    .eq('status', 'active')

  if (subCloseError) {
    // Non-fatal — the session cancellation itself already succeeded and
    // is the more important write. Log loudly so this doesn't go unnoticed.
    console.error(
      `[api/sessions/${sessionId}/cancel] error closing active sub_requests (non-fatal):`,
      subCloseError.message
    )
  }

  // ------------------------------------------------------------------
  // Step 4: Fetch CONFIRMED players only — tentative and waitlisted are
  // deliberately excluded per organizer decision (see file header).
  // signup_token is selected so each recipient gets a playerPageUrl below.
  // ------------------------------------------------------------------
  const { data: confirmedRows, error: confirmedError } = await supabaseAdmin
    .from('availability')
    .select('players ( first_name, email, signup_token )')
    .eq('session_id', sessionId)
    .eq('status', 'confirmed')

  if (confirmedError) {
    console.error(
      `[api/sessions/${sessionId}/cancel] error fetching confirmed players:`,
      confirmedError.message
    )
    // Session is already cancelled at this point — don't fail the whole
    // request over the notification fetch. Report zero notified.
    return Response.json({ success: true, notified: 0, failed: 0, warning: 'Could not fetch confirmed players for notification' })
  }

  const sessionDateLabel = session.session_date
    ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })
    : 'Unknown date'
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

  const recipients = (confirmedRows ?? [])
    .filter((r) => r.players?.email)
    .map((r) => ({
      playerFirstName: r.players.first_name,
      playerEmail: r.players.email,
      sessionDateLabel,
      locationName, // null on split days — email uses day-level wording
      cancellationNote,
      playerPageUrl: r.players.signup_token
        ? `${baseUrl}/signup/${r.players.signup_token}`
        : undefined,
    }))

  let emailResult = { sent: 0, failed: 0 }
  if (recipients.length > 0) {
    console.log(`[api/sessions/${sessionId}/cancel] sending cancellation notice to ${recipients.length} confirmed player(s)`)
    emailResult = await sendSessionCancellationNotice(recipients)
  } else {
    console.log(`[api/sessions/${sessionId}/cancel] no confirmed players — no notices sent`)
  }

  console.log(`[api/sessions/${sessionId}/cancel] complete — notified=${emailResult.sent} failed=${emailResult.failed}`)

  return Response.json({ success: true, notified: emailResult.sent, failed: emailResult.failed })
}