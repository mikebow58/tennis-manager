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
 *     courtLetter: string,      // 'A', 'B', 'C'
 *     courtNumber: number|null, // organiser-assigned real-world court number
 *     assignmentStatus: 'confirmed' | 'tentative',
 *   }>,
 *
 *   // Optional: players to cancel on approval.
 *   // These are players who were in the unassigned pool on the review screen —
 *   // their court was cancelled by the organiser and no replacement was found.
 *   // On approval: availability.status → 'cancelled', cancellation email sent.
 *   cancelledPlayers?: Array<{
 *     availabilityId: number,   // availability.id
 *     playerId: number,
 *     sessionId: number,
 *   }>,
 *
 *   // Optional: racquet-rotation pairings for this day. Replaces all
 *   // existing court_rotations rows for (weekId, sessionDate) — an empty
 *   // or omitted array clears all pairings.
 *   rotations?: Array<{
 *     winnersCourtLetter: string,
 *     secondCourtLetter: string,
 *     rotationType: 'rotate_partners' | 'keep_partners',
 *   }>,
 *
 *   // Optional: freeform per-court notes for this day. Upserted on
 *   // (weekId, sessionDate, courtLetter); any existing note for a court
 *   // not present in this array is deleted (organiser cleared it).
 *   courtNotes?: Array<{
 *     courtLetter: string,
 *     note: string,
 *   }>,
 *
 *   // Optional: locations added to this day on the fly (e.g. organiser
 *   // moves courts to a location with no existing session for this day —
 *   // a single-location day becoming multi-location at approval time).
 *   // For each entry, a new sessions row is created (copying session_date,
 *   // week_id, start_time, format, and notes from the anchor session,
 *   // status = 'closed'). placeholderSessionId ("new:<locationId>") is the
 *   // value used as sessionId in assignments/cancelledPlayers for courts
 *   // at this location — resolved to the new session's real id internally.
 *   newSessions?: Array<{
 *     placeholderSessionId: string,  // "new:<locationId>"
 *     locationId: number,
 *     courtsAvailable: number,       // count of courts moved to this location
 *   }>,
 *
 *   // Required if rotations or courtNotes are provided — identifies the
 *   // day these records belong to. Sourced from anchorSession server-side
 *   // when available; included here for client-side construction.
 *   weekId?: number,
 *   sessionDate?: string,       // 'YYYY-MM-DD'
 * }
 *
 * BEHAVIOUR:
 *   1. Verifies session exists and belongs to a sent/closed week.
 *   2. Resolves all sibling sessions for the day (multi-location).
 *   3. If newSessions provided: creates a sessions row per entry and
 *      resolves placeholder sessionIds in assignments/cancelledPlayers to
 *      the newly-created session ids.
 *   4. If cancelledPlayers provided: transitions availability to 'cancelled',
 *      sends sendCourtCancellationNotice to affected players.
 *   5. If assignments payload provided: validates and upserts to
 *      court_assignments, updates availability.court_letter.
 *   6. Replaces court_rotations and upserts/cleans court_notes for
 *      (week_id, session_date) — non-fatal if either step errors.
 *   7. Checks whether all courts have court_number set.
 *      If yes: sends player-facing emails with court number included.
 *      If no:  sends session-details-only email and returns a warning.
 *              Players will receive "check the posted sheet" message
 *              at 8pm backstop if not updated before then.
 *   8. Sets sessions.court_assignment_approved_at = now() and
 *      sessions.court_assignment_sent_at = now() on all sibling sessions
 *      (including any newly-created ones).
 *      Setting court_assignment_sent_at prevents the 8pm backstop from
 *      auto-firing for this day.
 *
 * SOFT WARNING (not a hard block):
 *   If some courts are missing court_number, the response includes
 *   { warning: '...' }. The organiser can proceed — consistent with
 *   the principle that the system never blocks the organiser.
 *
 * RESPONSES:
 *   200 { status: 'ok', courtsSent: number, cancelledCount: number,
 *         rotationsSaved: number, notesSaved: number,
 *         newSessionsCreated: number, warning?: string }
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
import {
  sendCourtAssignmentDetailsFull,
  sendCourtAssignmentDetails,
  sendCourtCancellationNotice,
} from '@/lib/email'

export async function POST(request, context) {
  // ---------------------------------------------------------------------------
  // 1. Safely resolve params (handles modern Next.js async promises).
  // ---------------------------------------------------------------------------
  const resolvedParams = context.params && typeof context.params.then === 'function'
    ? await context.params
    : context.params

  // Extract using the exact case-sensitive key found in diagnostics.
  const sessionId = resolvedParams.sessionID || resolvedParams.sessionId || resolvedParams.id

  console.log(`[api/admin/court-assignment/approve] POST received for session ${sessionId}`)

  // ---------------------------------------------------------------------------
  // 2. Parse request body.
  //    Both assignments and cancelledPlayers are optional.
  // ---------------------------------------------------------------------------
  let body = {}
  try {
    const text = await request.text()
    if (text) body = JSON.parse(text)
  } catch {
    return Response.json({ status: 'error', message: 'Invalid JSON body' }, { status: 400 })
  }

  const overrideAssignments = body.assignments ?? null
  const cancelledPlayers = body.cancelledPlayers ?? null
  const rotations = body.rotations ?? null       // [{ winnersCourtLetter, secondCourtLetter, rotationType }]
  const courtNotes = body.courtNotes ?? null     // [{ courtLetter, note }]
  const newSessions = body.newSessions ?? null   // [{ placeholderSessionId, locationId, courtsAvailable }]
  const bodyWeekId = body.weekId ?? null
  const bodySessionDate = body.sessionDate ?? null

  console.log(
    `[api/admin/court-assignment/approve] overrideAssignments: ${overrideAssignments?.length ?? 0}, ` +
    `cancelledPlayers: ${cancelledPlayers?.length ?? 0}, ` +
    `rotations: ${rotations?.length ?? 0}, courtNotes: ${courtNotes?.length ?? 0}, ` +
    `newSessions: ${newSessions?.length ?? 0}`
  )

  // ---------------------------------------------------------------------------
  // 3. Fetch anchor session.
  // ---------------------------------------------------------------------------
  const { data: anchorSession, error: anchorError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      week_id,
      session_date,
      start_time,
      format,
      notes,
      court_assignment_sent_at,
      locations ( id, name ),
      weeks!inner ( status )
    `)
    .eq('id', sessionId)
    .single()

  if (anchorError || !anchorSession) {
    console.error(`[api/admin/court-assignment/approve] Session ${sessionId} not found`)
    return Response.json(
      { status: 'error', message: `Session not found for ID: ${sessionId}` },
      { status: 404 }
    )
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
      cancelledCount: 0,
    })
  }

  // ---------------------------------------------------------------------------
  // 4. Resolve all sibling sessions for this day (multi-location support).
  // ---------------------------------------------------------------------------
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

  let sessionIds = daySessions.map((s) => s.id)
  console.log(`[api/admin/court-assignment/approve] Resolved ${sessionIds.length} session(s) for day.`)

  // ---------------------------------------------------------------------------
  // 4.5. Create new sessions for any locations added to this day on the fly
  //    (e.g. organiser moves courts to a location that had no session for
  //    this day previously). Each entry in newSessions corresponds to a
  //    placeholder sessionId ("new:<locationId>") used by assignments/
  //    cancelledPlayers below — build a map from placeholder -> real id.
  //
  //    New sessions copy session_date, week_id, start_time, format, and notes
  //    from the anchor session. status is set to 'closed' immediately, since
  //    this session is being created as part of the court assignment step
  //    (it has no independent open/reminder lifecycle of its own — Procedure
  //    1 never ran for it, but Procedure 2's output — the assignments payload
  //    — is what populates it).
  // ---------------------------------------------------------------------------
  const placeholderToRealSessionId = new Map()

  if (newSessions?.length) {
    for (const ns of newSessions) {
      const { data: createdSession, error: createSessionError } = await supabaseAdmin
        .from('sessions')
        .insert({
          week_id: anchorSession.week_id,
          session_date: anchorSession.session_date,
          start_time: anchorSession.start_time,
          format: anchorSession.format ?? null,
          notes: anchorSession.notes ?? null,
          location_id: ns.locationId,
          courts_available: ns.courtsAvailable,
          status: 'closed',
        })
        .select('id, start_time, notes, location_id, locations ( id, name )')
        .single()

      if (createSessionError || !createdSession) {
        console.error(
          `[api/admin/court-assignment/approve] Failed to create new session for location ${ns.locationId}:`,
          createSessionError?.message
        )
        return Response.json(
          { status: 'error', message: `Failed to create new session for location ${ns.locationId}: ${createSessionError?.message}` },
          { status: 500 }
        )
      }

      console.log(
        `[api/admin/court-assignment/approve] Created new session ${createdSession.id} ` +
        `for location ${ns.locationId} (courts_available=${ns.courtsAvailable})`
      )

      placeholderToRealSessionId.set(ns.placeholderSessionId, createdSession.id)
      daySessions.push(createdSession)
      sessionIds.push(createdSession.id)
    }
  }

  /**
   * Resolves a sessionId that may be a placeholder string ("new:<locationId>")
   * to its real numeric id, created in the step above. Numeric sessionIds
   * pass through unchanged.
   */
  function resolveSessionId(rawSessionId) {
    if (typeof rawSessionId === 'string' && rawSessionId.startsWith('new:')) {
      const real = placeholderToRealSessionId.get(rawSessionId)
      if (real == null) {
        throw new Error(`Could not resolve placeholder session id: ${rawSessionId}`)
      }
      return real
    }
    return rawSessionId
  }

  // Resolve placeholder sessionIds in assignments and cancelledPlayers before
  // any further processing — everything downstream expects real numeric ids.
  let resolvedAssignments = overrideAssignments
  let resolvedCancelledPlayers = cancelledPlayers

  try {
    if (overrideAssignments?.length) {
      resolvedAssignments = overrideAssignments.map((a) => ({
        ...a,
        sessionId: resolveSessionId(a.sessionId),
      }))
    }
    if (cancelledPlayers?.length) {
      resolvedCancelledPlayers = cancelledPlayers.map((p) => ({
        ...p,
        sessionId: resolveSessionId(p.sessionId),
      }))
    }
  } catch (resolveError) {
    console.error(`[api/admin/court-assignment/approve] Session id resolution failed:`, resolveError.message)
    return Response.json(
      { status: 'error', message: resolveError.message },
      { status: 500 }
    )
  }

  // ---------------------------------------------------------------------------
  // 5. Handle cancelled players — NEW.
  //    Transition availability records to 'cancelled' and send cancellation
  //    emails before processing confirmed assignments.
  //    We do this first so these players are excluded from the assignment emails.
  // ---------------------------------------------------------------------------
  let cancelledCount = 0

  if (resolvedCancelledPlayers?.length) {
    console.log(`[api/admin/court-assignment/approve] Processing ${resolvedCancelledPlayers.length} cancellation(s).`)

    const cancelledAvailabilityIds = resolvedCancelledPlayers.map(p => p.availabilityId)

    // Transition availability records to cancelled status.
    const { error: cancelError } = await supabaseAdmin
      .from('availability')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        court_assignment_status: null, // clear tentative assignment
      })
      .in('id', cancelledAvailabilityIds)

    if (cancelError) {
      console.error(`[api/admin/court-assignment/approve] Cancellation update failed:`, cancelError.message)
      return Response.json(
        { status: 'error', message: `Cancellation update failed: ${cancelError.message}` },
        { status: 500 }
      )
    }

    // Fetch player and session details needed for the cancellation email.
    // We need: playerFirstName, playerEmail, sessionDate, startTime, locationName.
    const cancelledPlayerIds = resolvedCancelledPlayers.map(p => p.playerId)
    const cancelledSessionIds = [...new Set(resolvedCancelledPlayers.map(p => p.sessionId))]

    const { data: cancelledPlayerRecords } = await supabaseAdmin
      .from('players')
      .select('id, first_name, email')
      .in('id', cancelledPlayerIds)

    // Build a sessionId → session lookup for start_time and location.
    const cancelledSessionLookup = {}
    for (const s of daySessions) {
      if (cancelledSessionIds.includes(s.id)) {
        cancelledSessionLookup[s.id] = s
      }
    }

    const sessionDateLabel = formatSessionDateLabel(anchorSession.session_date)
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

    // Build the cancellation email payload — one entry per cancelled player.
    const cancellationEmailPayloads = []
    for (const cp of resolvedCancelledPlayers) {
      const playerRecord = cancelledPlayerRecords?.find(p => p.id === cp.playerId)
      const sessionRecord = cancelledSessionLookup[cp.sessionId]
      if (!playerRecord || !sessionRecord) continue

      cancellationEmailPayloads.push({
        playerFirstName: playerRecord.first_name,
        playerEmail: playerRecord.email,
        sessionDate: sessionDateLabel,
        startTime: formatStartTime(sessionRecord.start_time),
        locationName: sessionRecord.locations?.name ?? 'TBD',
      })
    }

    if (cancellationEmailPayloads.length > 0) {
      const { sent } = await sendCourtCancellationNotice(cancellationEmailPayloads)
      cancelledCount = sent
      console.log(`[api/admin/court-assignment/approve] Cancellation emails sent: ${cancelledCount}`)
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Apply override assignments if provided.
  //    Upsert court_assignments and update availability.court_letter.
  // ---------------------------------------------------------------------------
  if (resolvedAssignments?.length) {
    console.log(`[api/admin/court-assignment/approve] Applying ${resolvedAssignments.length} override assignment(s).`)

    const caRows = resolvedAssignments.map((a) => ({
      session_id: a.sessionId,
      player_id: a.playerId,
      location_id: a.locationId,
      court_letter: a.courtLetter,   // court_letter added in migration 20260531000000
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
    // Group availability IDs by court letter to minimise DB round-trips.
    const byLetter = new Map()
    for (const a of resolvedAssignments) {
      if (!byLetter.has(a.courtLetter)) byLetter.set(a.courtLetter, [])
      byLetter.get(a.courtLetter).push(a.availabilityId)
    }

    for (const [courtLetter, ids] of byLetter) {
      const { error: availError } = await supabaseAdmin
        .from('availability')
        .update({ court_letter: courtLetter })
        .in('id', ids)

      if (availError) {
        // Non-fatal — court_assignments is the source of truth for letters.
        console.error(
          `[api/admin/court-assignment/approve] availability court_letter update failed for ` +
          `court ${courtLetter}:`, availError.message
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6.5. Replace court_rotations and upsert/clean court_notes for this day.
  //    Both tables key on (week_id, session_date) — day-level concepts, like
  //    court letters. anchorSession already carries the authoritative values.
  // ---------------------------------------------------------------------------
  const dayWeekId = anchorSession.week_id
  const daySessionDate = anchorSession.session_date

  // --- court_rotations: full replace for the day ---------------------------
  const { error: deleteRotationsError } = await supabaseAdmin
    .from('court_rotations')
    .delete()
    .eq('week_id', dayWeekId)
    .eq('session_date', daySessionDate)

  if (deleteRotationsError) {
    console.error(
      `[api/admin/court-assignment/approve] court_rotations delete failed:`,
      deleteRotationsError.message
    )
  }

  if (rotations?.length) {
    const rotationRows = rotations.map((r) => ({
      week_id: dayWeekId,
      session_date: daySessionDate,
      winners_court_letter: r.winnersCourtLetter,
      second_court_letter: r.secondCourtLetter,
      rotation_type: r.rotationType,
    }))

    const { error: insertRotationsError } = await supabaseAdmin
      .from('court_rotations')
      .insert(rotationRows)

    if (insertRotationsError) {
      console.error(
        `[api/admin/court-assignment/approve] court_rotations insert failed:`,
        insertRotationsError.message
      )
    } else {
      console.log(
        `[api/admin/court-assignment/approve] court_rotations: ${rotationRows.length} pairing(s) saved for day ${daySessionDate}.`
      )
    }
  } else {
    console.log(
      `[api/admin/court-assignment/approve] court_rotations: no pairings for day ${daySessionDate} (cleared).`
    )
  }

  // --- court_notes: upsert present, delete removed --------------------------
  if (courtNotes?.length) {
    const noteRows = courtNotes.map((n) => ({
      week_id: dayWeekId,
      session_date: daySessionDate,
      court_letter: n.courtLetter,
      note: n.note,
      updated_at: new Date().toISOString(),
    }))

    const { error: upsertNotesError } = await supabaseAdmin
      .from('court_notes')
      .upsert(noteRows, { onConflict: 'week_id,session_date,court_letter' })

    if (upsertNotesError) {
      console.error(
        `[api/admin/court-assignment/approve] court_notes upsert failed:`,
        upsertNotesError.message
      )
    } else {
      console.log(
        `[api/admin/court-assignment/approve] court_notes: ${noteRows.length} note(s) saved for day ${daySessionDate}.`
      )
    }

    const currentLetters = courtNotes.map((n) => n.courtLetter)
    const { error: deleteStaleNotesError } = await supabaseAdmin
      .from('court_notes')
      .delete()
      .eq('week_id', dayWeekId)
      .eq('session_date', daySessionDate)
      .not('court_letter', 'in', `(${currentLetters.map(l => `"${l}"`).join(',')})`)

    if (deleteStaleNotesError) {
      console.error(
        `[api/admin/court-assignment/approve] stale court_notes cleanup failed:`,
        deleteStaleNotesError.message
      )
    }
  } else {
    const { error: deleteAllNotesError } = await supabaseAdmin
      .from('court_notes')
      .delete()
      .eq('week_id', dayWeekId)
      .eq('session_date', daySessionDate)

    if (deleteAllNotesError) {
      console.error(
        `[api/admin/court-assignment/approve] court_notes clear failed:`,
        deleteAllNotesError.message
      )
    } else {
      console.log(
        `[api/admin/court-assignment/approve] court_notes: no notes for day ${daySessionDate} (cleared).`
      )
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Read current court_assignments to determine:
  //    (a) which players are confirmed (need assignment emails)
  //    (b) whether all courts have court_number set (soft warning check)
  //
  //    Filter to confirmed only — tentative players either got cancelled in
  //    step 5 or were moved to confirmed courts by the organiser.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 7.5. Build rotation/note lookups by court letter, for inclusion in the
  //    full-detail assignment email. Only relevant when court numbers are
  //    set (the full-detail path) — without a court number, players are
  //    told to check the posted sheet, where rotation/notes will appear
  //    once the printable lineup sheet is built.
  // ---------------------------------------------------------------------------
  const { data: dayRotations } = await supabaseAdmin
    .from('court_rotations')
    .select('winners_court_letter, second_court_letter, rotation_type')
    .eq('week_id', dayWeekId)
    .eq('session_date', daySessionDate)

  const { data: dayNotes } = await supabaseAdmin
    .from('court_notes')
    .select('court_letter, note')
    .eq('week_id', dayWeekId)
    .eq('session_date', daySessionDate)

  // courtNumberByLetter: court_letter -> organiser-assigned court_number.
  // Built from the assignments just read — used to render rotation labels
  // with real-world court numbers instead of internal letters.
  const courtNumberByLetter = {}
  for (const a of assignments) {
    if (a.court_number != null) {
      courtNumberByLetter[a.court_letter] = a.court_number
    }
  }

  // rotationLabelByLetter: court_letter -> human-readable rotation sentence.
  // Built from both sides of each pairing so each court gets its own framing
  // (the winners court vs. the second court read slightly differently).
  // Player-facing text uses court NUMBERS (what's in the info box above),
  // not internal letters. Falls back to "Court [letter]" only if a number
  // hasn't been assigned for that side — keeps the sentence readable even
  // in an incomplete-numbering edge case.
  const rotationLabelByLetter = {}
  for (const r of dayRotations ?? []) {
    const partnerText = r.rotation_type === 'keep_partners'
      ? 'Keeping the same partner.'
      : 'Switching partners each set.'

    const winnersLabel = courtNumberByLetter[r.winners_court_letter] != null
      ? `Court ${courtNumberByLetter[r.winners_court_letter]}`
      : `Court ${r.winners_court_letter}`

    const secondLabel = courtNumberByLetter[r.second_court_letter] != null
      ? `Court ${courtNumberByLetter[r.second_court_letter]}`
      : `Court ${r.second_court_letter}`

    rotationLabelByLetter[r.winners_court_letter] =
      `${winnersLabel} (winner's court), rotating with ${secondLabel}. ${partnerText}`

    rotationLabelByLetter[r.second_court_letter] =
      `${secondLabel}, rotating with ${winnersLabel} (winner's court). ${partnerText}`
  }

  // courtNoteByLetter: court_letter -> freeform organiser note text.
  const courtNoteByLetter = {}
  for (const n of dayNotes ?? []) {
    courtNoteByLetter[n.court_letter] = n.note
  }

  console.log(
    `[api/admin/court-assignment/approve] Loaded ${dayRotations?.length ?? 0} rotation pairing(s) ` +
    `and ${dayNotes?.length ?? 0} note(s) for day ${daySessionDate}.`
  )

  // ---------------------------------------------------------------------------
  // 8. Soft warning check: any confirmed court missing a court_number?
  //    The system never blocks the organiser — we warn but proceed.
  // ---------------------------------------------------------------------------
  const hasMissingNumbers = assignments.some((a) => a.court_number == null)

  console.log(
    `[api/admin/court-assignment/approve] ${assignments.length} confirmed assignment(s). ` +
    `hasMissingNumbers=${hasMissingNumbers} cancelledCount=${cancelledCount}`
  )

  // ---------------------------------------------------------------------------
  // 9. Send player-facing assignment emails.
  // ---------------------------------------------------------------------------
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  const sessionDateLabel = formatSessionDateLabel(anchorSession.session_date)
  let courtsSent = 0

  if (!hasMissingNumbers && assignments.length > 0) {
    // All courts have numbers — send full detail email including court number.
    // This is the email players actually care about: "You're on Court 3."
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
        rotationLabel: rotationLabelByLetter[a.court_letter] ?? null,
        courtNote: courtNoteByLetter[a.court_letter] ?? null,
        cancelUrl: `${baseUrl}/portal/${a.players.signup_token}`,
      }
    })

    const { sent } = await sendCourtAssignmentDetailsFull(emailPayloads)
    courtsSent = sent
    console.log(`[api/admin/court-assignment/approve] Full detail emails sent: ${courtsSent}`)

  } else if (assignments.length > 0) {
    // Missing court numbers — session details only.
    // Players get time and location but "court assignment will be posted at the courts."
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

  // ---------------------------------------------------------------------------
  // 10. Finalise: set court_assignment_approved_at and court_assignment_sent_at
  //     on all sibling sessions.
  //     Setting court_assignment_sent_at is the idempotency guard that prevents
  //     the 8pm backstop from auto-firing for this day.
  // ---------------------------------------------------------------------------
  const now = new Date().toISOString()

  const { error: finaliseError } = await supabaseAdmin
    .from('sessions')
    .update({
      court_assignment_approved_at: now,
      court_assignment_sent_at: now,
    })
    .in('id', sessionIds)

  if (finaliseError) {
    console.error(
      `[api/admin/court-assignment/approve] Error setting finalisation timestamps:`,
      finaliseError.message
    )
    // Emails were sent — return success with warning so the organiser knows
    // to check manually. The 8pm backstop may re-fire without the timestamp set.
    return Response.json({
      status: 'ok',
      courtsSent,
      cancelledCount,
      warning:
        'Emails sent but failed to set court_assignment_sent_at — 8pm backstop may re-fire. ' +
        'Manual review required.',
    })
  }

  console.log(
    `[api/admin/court-assignment/approve] Finalised session ${sessionId} ` +
    `(day ${anchorSession.session_date}). courtsSent=${courtsSent} ` +
    `cancelledCount=${cancelledCount} hasMissingNumbers=${hasMissingNumbers}`
  )

  // ---------------------------------------------------------------------------
  // 11. Build and return response.
  // ---------------------------------------------------------------------------
  const responseBody = {
    status: 'ok',
    courtsSent,
    cancelledCount,
    rotationsSaved: rotations?.length ?? 0,
    notesSaved: courtNotes?.length ?? 0,
    newSessionsCreated: placeholderToRealSessionId.size,
  }

  if (hasMissingNumbers) {
    responseBody.warning =
      'Some courts are missing court numbers. Players have been sent session details only. ' +
      'Update court numbers and re-approve, or players will receive "check the posted sheet" ' +
      'message if the 8pm backstop fires.'
  }

  return Response.json(responseBody)
}

// ---------------------------------------------------------------------------
// Local helpers — date/time formatting.
// Same helpers as original route — kept local to avoid adding a lib dependency.
// ---------------------------------------------------------------------------

/**
 * Formats a session_date string (YYYY-MM-DD) into a human-readable label.
 * Parses as UTC noon to prevent timezone rollover issues.
 * @param {string} sessionDate - e.g. "2026-06-12"
 * @returns {string} e.g. "Friday, June 12"
 */
function formatSessionDateLabel(sessionDate) {
  const date = new Date(sessionDate + 'T12:00:00Z')
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

/**
 * Formats a Postgres time string (HH:MM:SS) into a display-friendly label.
 * @param {string|null} startTime - e.g. "09:00:00"
 * @returns {string} e.g. "9:00 AM"
 */
function formatStartTime(startTime) {
  if (!startTime) return 'TBD'
  return new Date(`1970-01-01T${startTime}Z`).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
  })
}