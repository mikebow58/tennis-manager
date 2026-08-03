// app/api/sessions/[sessionId]/cancel/route.js
//
// POST /api/sessions/[sessionId]/cancel — cancels a session in place. This
// is the organiser's simplified cancellation design (Option D, agreed in
// this session — see Project Summary Section 21 "Session cancellation
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
//     Tentative and waitlisted players are NOT emailed — organiser decision:
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
// cancelled session — see the cancelled_at guards added to
// app/api/availability/route.js (player-facing) and
// app/api/admin/availability/route.js (organiser manual add) in this same
// revision. This route does not itself prevent future signups; it only
// marks the session and notifies existing confirmed players.
//
// Tables read:  sessions, availability, sub_requests
// Tables written: sessions (cancelled_at, cancellation_note),
//   sub_requests (status → closed, active rows only)

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendSessionCancellationNotice } from '@/lib/email'

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
    .select('id, session_date, start_time, cancelled_at, locations ( name )')
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
  // deliberately excluded per organiser decision (see file header).
  // ------------------------------------------------------------------
  const { data: confirmedRows, error: confirmedError } = await supabaseAdmin
    .from('availability')
    .select('players ( first_name, email )')
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
  const locationName = session.locations?.name ?? 'TBD'

  const recipients = (confirmedRows ?? [])
    .filter((r) => r.players?.email)
    .map((r) => ({
      playerFirstName: r.players.first_name,
      playerEmail: r.players.email,
      sessionDateLabel,
      locationName,
      cancellationNote,
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