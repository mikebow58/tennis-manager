/**
 * POST /api/admin/court-assignment/[sessionId]/approve
 *
 * Finalises court assignments for a session day. Accepts any sessionId
 * belonging to the target day — sibling sessions on multi-location days
 * are resolved automatically from week_id + session_date.
 *
 * Protected by auth middleware — requires an authenticated session.
 * No manual token check needed (same pattern as /api/admin/availability).
 *
 * REQUEST BODY (JSON):
 * {
 *   // Optional: organiser-adjusted court assignments.
 *   // If omitted, the existing Procedure 2 results are used as-is.
 *   // If provided, replaces the current court_assignments records before
 *   // finalising. Each entry must include all required fields.
 *   assignments?: Array<{
 *     availabilityId: number,   // availability.id
 *     playerId: number,
 *     sessionId: number,
 *     locationId: number,
 *     courtLetter: string,      // 'A', 'B', 'C'...
 *     courtNumber: number|null, // organiser-assigned real-world court number
 *     assignmentStatus: 'confirmed' | 'tentative',
 *   }>
 * }
 *
 * BEHAVIOUR:
 *   1. Verifies session exists and belongs to a sent/closed week.
 *   2. Resolves all sibling sessions for the day (multi-location).
 *   3. If assignments payload provided: validates and upserts to
 *      court_assignments, updates availability.court_letter.
 *   4. Checks whether all courts have court_number set.
 *      If yes: sends player-facing emails with court number included.
 *      If no:  sends session-details-only email and returns a warning.
 *              Players will receive "check the posted sheet" message
 *              at 8pm backstop if not updated before then.
 *   5. Sets sessions.court_assignment_approved_at = now() and
 *      sessions.court_assignment_sent_at = now() on all sibling sessions.
 *      Setting court_assignment_sent_at prevents the 8pm backstop from
 *      auto-firing for this day.
 *
 * SOFT WARNING (not a hard block):
 *   If some courts are missing court_number, the response includes
 *   { warning: '...' }. The organiser can proceed — consistent with
 *   the principle that the system never blocks the organiser.
 *
 * RESPONSES:
 *   200 { status: 'ok', courtsSent: number, warning?: string }
 *   400 { status: 'error', message: string }
 *   404 Session not found
 *   500 Internal error
 *
 * References:
 *   Phase 1 Section 4.8 (Path AA/A — event-driven approval)
 *   Phase 2 Section 4.5 (Procedure 2 outcomes)
 *   Automation Logic Section 8.2 (court assignment notification paths)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendCourtAssignmentDetailsFull, sendCourtAssignmentDetails } from '@/lib/email'

export async function POST(request, { params }) {
  const { sessionId } = params

  console.log(`[api/admin/court-assignment/approve] POST received for session ${sessionId}`)

  // ------------------------------------------------------------------
  // Parse optional assignments payload.
  // ------------------------------------------------------------------
  let body = {}
  try {
    const text = await request.text()
    if (text) body = JSON.parse(text)
  } catch {
    return Response.json({ status: 'error', message: 'Invalid JSON body' }, { status: 400 })
  }

  const overrideAssignments = body.assignments ?? null

  // ------------------------------------------------------------------
  // Fetch anchor session.
  // ------------------------------------------------------------------
  const { data: anchorSession, error: anchorError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      week_id,
      session_date,
      start_time,
      notes,
      court_assignment_sent_at,
      locations ( id, name ),
      weeks!inner ( status )
    `)
    .eq('id', sessionId)
    .single()

  if (anchorError || !anchorSession) {
    console.error(`[api/admin/court-assignment/approve] Session ${sessionId} not found`)
    return Response.json({ status: 'error', message: 'Session not found' }, { status: 404 })
  }

  if (anchorSession.weeks.status !== 'sent') {
    return Response.json(
      { status: 'error', message: 'Week is not in sent status' },
      { status: 400 }
    )
  }

  // Idempotency guard: already approved and sent — return success.
  if (anchorSession.court_assignment_sent_at) {
    console.log(`[api/admin/court-assignment/approve] Session ${sessionId} already finalised.`)
    return Response.json({
      status: 'ok',
      message: 'Court assignments already finalised for this session.',
      courtsSent: 0,
    })
  }

  // ------------------------------------------------------------------
  // Resolve all sibling sessions for this day (multi-location support).
  // ------------------------------------------------------------------
  const { data: daySessions, error: dayError } = await supabaseAdmin
    .from('sessions')
    .select('id, start_time, notes, location_id, locations ( id, name )')
    .eq('week_id', anchorSession.week_id)
    .eq('session_date', anchorSession.session_date)
    .eq('status', 'closed')
    .is('cancelled_at', null)

  if (dayError || !daySessions?.length) {
    console.error(`[api/admin/court-assignment/approve] Could not resolve day sessions:`, dayError?.message)
    return Response.json(
      { status: 'error', message: 'Could not resolve day sessions' },
      { status: 500 }
    )
  }

  const sessionIds = daySessions.map((s) => s.id)
  console.log(`[api/admin/court-assignment/approve] Resolved ${sessionIds.length} session(s) for day.`)

  // ------------------------------------------------------------------
  // Apply override assignments if provided.
  // Upsert court_assignments and update availability.court_letter.
  // ------------------------------------------------------------------
  if (overrideAssignments?.length) {
    console.log(`[api/admin/court-assignment/approve] Applying ${overrideAssignments.length} override assignment(s).`)

    const caRows = overrideAssignments.map((a) => ({
      session_id: a.sessionId,
      player_id: a.playerId,
      location_id: a.locationId,
      court_number: a.courtNumber ?? null,
      assignment_status: a.assignmentStatus,
      updated_at: new Date().toISOString(),
    }))

    const { error: upsertError } = await supabaseAdmin
      .from('court_assignments')
      .upsert(caRows, { onConflict: 'player_id,session_id', ignoreDuplicates: false })

    if (upsertError) {
      console.error(`[api/admin/court-assignment/approve] court_assignments upsert failed:`, upsertError.message)
      return Response.json(
        { status: 'error', message: `court_assignments upsert failed: ${upsertError.message}` },
        { status: 500 }
      )
    }

    // Update availability.court_letter grouped by court letter.
    const byLetter = new Map()
    for (const a of overrideAssignments) {
      if (!byLetter.has(a.courtLetter)) byLetter.set(a.courtLetter, [])
      byLetter.get(a.courtLetter).push(a.availabilityId)
    }

    for (const [courtLetter, ids] of byLetter) {
      const { error: availError } = await supabaseAdmin
        .from('availability')
        .update({ court_letter: courtLetter })
        .in('id', ids)

      if (availError) {
        // Non-fatal — court_assignments is the source of truth.
        console.error(`[api/admin/court-assignment/approve] availability update failed for court ${courtLetter}:`, availError.message)
      }
    }
  }

  // ------------------------------------------------------------------
  // Read current court_assignments to determine:
  //   (a) which players are confirmed (need emails)
  //   (b) whether all courts have court_number set (soft warning check)
  // ------------------------------------------------------------------
  const { data: assignments, error: readError } = await supabaseAdmin
    .from('court_assignments')
    .select(`
      court_number,
      court_letter,
      assignment_status,
      location_id,
      session_id,
      players ( id, first_name, last_name, email, signup_token ),
      locations ( name )
    `)
    .in('session_id', sessionIds)
    .eq('assignment_status', 'confirmed')

  if (readError) {
    console.error(`[api/admin/court-assignment/approve] Could not read assignments:`, readError.message)
    return Response.json(
      { status: 'error', message: `Could not read assignments: ${readError.message}` },
      { status: 500 }
    )
  }

  // ------------------------------------------------------------------
  // Soft warning check: any confirmed court missing a court_number?
  // ------------------------------------------------------------------
  const hasMissingNumbers = assignments.some((a) => a.court_number == null)

  console.log(
    `[api/admin/court-assignment/approve] ${assignments.length} confirmed assignment(s). ` +
    `hasMissingNumbers=${hasMissingNumbers}`
  )

  // ------------------------------------------------------------------
  // Send player-facing emails.
  // ------------------------------------------------------------------
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  const sessionDateLabel = formatSessionDateLabel(anchorSession.session_date)
  let courtsSent = 0

  if (!hasMissingNumbers && assignments.length > 0) {
    // All courts have numbers — send full details with court number.
    const emailPayloads = assignments.map((a) => {
      const playerSession = daySessions.find((s) => s.id === a.session_id)
      return {
        playerFirstName: a.players.first_name,
        playerEmail: a.players.email,
        sessionDate: sessionDateLabel,
        startTime: formatStartTime(playerSession?.start_time),
        locationName: a.locations?.name ?? 'TBD',
        courtNumber: a.court_number,
        notes: playerSession?.notes ?? null,
        cancelUrl: `${baseUrl}/portal/${a.players.signup_token}`,
      }
    })

    const { sent } = await sendCourtAssignmentDetailsFull(emailPayloads)
    courtsSent = sent
    console.log(`[api/admin/court-assignment/approve] Full detail emails sent: ${courtsSent}`)

  } else if (assignments.length > 0) {
    // Missing court numbers — session details only.
    const emailPayloads = assignments.map((a) => {
      const playerSession = daySessions.find((s) => s.id === a.session_id)
      return {
        playerFirstName: a.players.first_name,
        playerEmail: a.players.email,
        sessionDate: sessionDateLabel,
        startTime: formatStartTime(playerSession?.start_time),
        locationName: a.locations?.name ?? 'TBD',
        notes: playerSession?.notes ?? null,
        cancelUrl: `${baseUrl}/portal/${a.players.signup_token}`,
      }
    })

    const { sent } = await sendCourtAssignmentDetails(emailPayloads)
    courtsSent = sent
    console.log(`[api/admin/court-assignment/approve] Session-details-only emails sent: ${courtsSent}`)
  }

  // ------------------------------------------------------------------
  // Finalise: set court_assignment_approved_at and
  // court_assignment_sent_at on all sibling sessions.
  // Setting court_assignment_sent_at prevents the 8pm backstop
  // from auto-firing for this day.
  // ------------------------------------------------------------------
  const now = new Date().toISOString()

  const { error: finaliseError } = await supabaseAdmin
    .from('sessions')
    .update({
      court_assignment_approved_at: now,
      court_assignment_sent_at: now,
    })
    .in('id', sessionIds)

  if (finaliseError) {
    console.error(`[api/admin/court-assignment/approve] Error setting finalisation timestamps:`, finaliseError.message)
    // Emails were sent — return success with warning so the organiser knows
    // to check manually. The 8pm backstop may re-fire without the timestamp set.
    return Response.json({
      status: 'ok',
      courtsSent,
      warning: 'Emails sent but failed to set court_assignment_sent_at — 8pm backstop may re-fire. Manual review required.',
    })
  }

  console.log(
    `[api/admin/court-assignment/approve] Finalised session ${sessionId} ` +
    `(day ${anchorSession.session_date}). courtsSent=${courtsSent} hasMissingNumbers=${hasMissingNumbers}`
  )

  const responseBody = { status: 'ok', courtsSent }
  if (hasMissingNumbers) {
    responseBody.warning =
      'Some courts are missing court numbers. Players have been sent session details only. ' +
      'Update court numbers and re-approve, or players will receive "check the posted sheet" ' +
      'message if the 8pm backstop fires.'
  }

  return Response.json(responseBody)
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