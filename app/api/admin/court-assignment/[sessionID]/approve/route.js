/**
 * POST /api/admin/court-assignment/[sessionId]/approve
 * Full replacement — adds partner_setting to court_assignments writes.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendCourtAssignmentDetailsFull,
  sendCourtAssignmentDetails,
  sendCourtCancellationNotice,
} from '@/lib/email'

export async function POST(request, context) {
  const resolvedParams = context.params && typeof context.params.then === 'function'
    ? await context.params
    : context.params
  const sessionId = resolvedParams.sessionID || resolvedParams.sessionId || resolvedParams.id

  console.log(`[api/admin/court-assignment/approve] POST received for session ${sessionId}`)

  let body = {}
  try {
    const text = await request.text()
    if (text) body = JSON.parse(text)
  } catch {
    return Response.json({ status: 'error', message: 'Invalid JSON body' }, { status: 400 })
  }

  const overrideAssignments = body.assignments ?? null
  const cancelledPlayers   = body.cancelledPlayers ?? null
  const rotations          = body.rotations ?? null
  const courtNotes         = body.courtNotes ?? null
  const newSessions        = body.newSessions ?? null
  const bodyWeekId         = body.weekId ?? null
  const bodySessionDate    = body.sessionDate ?? null

  console.log(
    `[api/admin/court-assignment/approve] assignments:${overrideAssignments?.length ?? 0} ` +
    `cancelled:${cancelledPlayers?.length ?? 0} rotations:${rotations?.length ?? 0} ` +
    `notes:${courtNotes?.length ?? 0} newSessions:${newSessions?.length ?? 0}`
  )

  // Fetch anchor session
  const { data: anchorSession, error: anchorError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id, week_id, session_date, start_time, format, notes,
      court_assignment_sent_at,
      locations ( id, name ),
      weeks!inner ( status )
    `)
    .eq('id', sessionId)
    .single()

  if (anchorError || !anchorSession) {
    return Response.json({ status: 'error', message: `Session not found for ID: ${sessionId}` }, { status: 404 })
  }

  if (anchorSession.weeks.status !== 'sent') {
    return Response.json({ status: 'error', message: 'Week is not in sent status' }, { status: 400 })
  }

  if (anchorSession.court_assignment_sent_at) {
    return Response.json({ status: 'ok', message: 'Court assignments already finalised.', courtsSent: 0, cancelledCount: 0 })
  }

  // Resolve sibling sessions
  const { data: daySessions, error: dayError } = await supabaseAdmin
    .from('sessions')
    .select('id, start_time, notes, location_id, locations ( id, name )')
    .eq('week_id', anchorSession.week_id)
    .eq('session_date', anchorSession.session_date)
    .eq('status', 'closed')
    .is('cancelled_at', null)

  if (dayError || !daySessions?.length) {
    return Response.json({ status: 'error', message: 'Could not resolve day sessions' }, { status: 500 })
  }

  let sessionIds = daySessions.map(s => s.id)

  // Create new sessions for on-the-fly location additions
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
        return Response.json({ status: 'error', message: `Failed to create new session for location ${ns.locationId}: ${createSessionError?.message}` }, { status: 500 })
      }

      placeholderToRealSessionId.set(ns.placeholderSessionId, createdSession.id)
      daySessions.push(createdSession)
      sessionIds.push(createdSession.id)
    }
  }

  function resolveSessionId(rawSessionId) {
    if (typeof rawSessionId === 'string' && rawSessionId.startsWith('new:')) {
      const real = placeholderToRealSessionId.get(rawSessionId)
      if (real == null) throw new Error(`Could not resolve placeholder session id: ${rawSessionId}`)
      return real
    }
    return rawSessionId
  }

  let resolvedAssignments = overrideAssignments
  let resolvedCancelledPlayers = cancelledPlayers

  try {
    if (overrideAssignments?.length) {
      resolvedAssignments = overrideAssignments.map(a => ({ ...a, sessionId: resolveSessionId(a.sessionId) }))
    }
    if (cancelledPlayers?.length) {
      resolvedCancelledPlayers = cancelledPlayers.map(p => ({ ...p, sessionId: resolveSessionId(p.sessionId) }))
    }
  } catch (resolveError) {
    return Response.json({ status: 'error', message: resolveError.message }, { status: 500 })
  }

  // Handle cancellations
  let cancelledCount = 0

  if (resolvedCancelledPlayers?.length) {
    const cancelledAvailabilityIds = resolvedCancelledPlayers.map(p => p.availabilityId)

    const { error: cancelError } = await supabaseAdmin
      .from('availability')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), court_assignment_status: null })
      .in('id', cancelledAvailabilityIds)

    if (cancelError) {
      return Response.json({ status: 'error', message: `Cancellation update failed: ${cancelError.message}` }, { status: 500 })
    }

    const cancelledPlayerIds = resolvedCancelledPlayers.map(p => p.playerId)
    const cancelledSessionIds = [...new Set(resolvedCancelledPlayers.map(p => p.sessionId))]
    const { data: cancelledPlayerRecords } = await supabaseAdmin.from('players').select('id, first_name, email').in('id', cancelledPlayerIds)
    const cancelledSessionLookup = {}
    for (const s of daySessions) { if (cancelledSessionIds.includes(s.id)) cancelledSessionLookup[s.id] = s }
    const sessionDateLabel = formatSessionDateLabel(anchorSession.session_date)

    const cancellationEmailPayloads = []
    for (const cp of resolvedCancelledPlayers) {
      const playerRecord = cancelledPlayerRecords?.find(p => p.id === cp.playerId)
      const sessionRecord = cancelledSessionLookup[cp.sessionId]
      if (!playerRecord || !sessionRecord) continue
      cancellationEmailPayloads.push({
        playerFirstName: playerRecord.first_name, playerEmail: playerRecord.email,
        sessionDate: sessionDateLabel, startTime: formatStartTime(sessionRecord.start_time),
        locationName: sessionRecord.locations?.name ?? 'TBD',
      })
    }

    if (cancellationEmailPayloads.length > 0) {
      const { sent } = await sendCourtCancellationNotice(cancellationEmailPayloads)
      cancelledCount = sent
    }
  }

  // Apply override assignments
  if (resolvedAssignments?.length) {
    const playerIdsInAssignments = [...new Set(resolvedAssignments.map(a => a.playerId))]

    const { error: staleDeleteError } = await supabaseAdmin
      .from('court_assignments')
      .delete()
      .in('session_id', sessionIds)
      .in('player_id', playerIdsInAssignments)

    if (staleDeleteError) {
      return Response.json({ status: 'error', message: `court_assignments cleanup failed: ${staleDeleteError.message}` }, { status: 500 })
    }

    const caRows = resolvedAssignments.map(a => ({
      session_id: a.sessionId,
      player_id: a.playerId,
      location_id: a.locationId,
      court_letter: a.courtLetter,
      court_number: a.courtNumber ?? null,
      team_number: a.teamNumber ?? null,
      partner_setting: a.partnerSetting ?? null,
      assignment_status: a.assignmentStatus,
      updated_at: new Date().toISOString(),
    }))

    const { error: insertError } = await supabaseAdmin.from('court_assignments').insert(caRows)
    if (insertError) {
      return Response.json({ status: 'error', message: `court_assignments insert failed: ${insertError.message}` }, { status: 500 })
    }

    // Update availability court_letter and team_number grouped by (letter, team)
    const grouped = new Map()
    for (const a of resolvedAssignments) {
      const key = `${a.courtLetter}::${a.teamNumber ?? 'null'}`
      if (!grouped.has(key)) grouped.set(key, { ids: [], courtLetter: a.courtLetter, teamNumber: a.teamNumber ?? null })
      grouped.get(key).ids.push(a.availabilityId)
    }

    for (const [, { ids, courtLetter, teamNumber }] of grouped) {
      const { error: availError } = await supabaseAdmin
        .from('availability')
        .update({ court_letter: courtLetter, team_number: teamNumber })
        .in('id', ids)
      if (availError) {
        console.error(`[approve] availability update failed for court ${courtLetter}:`, availError.message)
      }
    }
  }

  // Replace court_rotations for the day
  const dayWeekId = anchorSession.week_id
  const daySessionDate = anchorSession.session_date

  await supabaseAdmin.from('court_rotations').delete().eq('week_id', dayWeekId).eq('session_date', daySessionDate)

  if (rotations?.length) {
    const rotationRows = rotations.map(r => ({
      week_id: dayWeekId, session_date: daySessionDate,
      winners_court_letter: r.winnersCourtLetter,
      second_court_letter: r.secondCourtLetter,
      rotation_type: r.rotationType,
    }))
    const { error: insertRotationsError } = await supabaseAdmin.from('court_rotations').insert(rotationRows)
    if (insertRotationsError) console.error('[approve] court_rotations insert failed:', insertRotationsError.message)
  }

  // Upsert / clear court_notes
  if (courtNotes?.length) {
    const noteRows = courtNotes.map(n => ({
      week_id: dayWeekId, session_date: daySessionDate,
      court_letter: n.courtLetter, note: n.note, updated_at: new Date().toISOString(),
    }))
    await supabaseAdmin.from('court_notes').upsert(noteRows, { onConflict: 'week_id,session_date,court_letter' })
    const currentLetters = courtNotes.map(n => n.courtLetter)
    await supabaseAdmin.from('court_notes').delete()
      .eq('week_id', dayWeekId).eq('session_date', daySessionDate)
      .not('court_letter', 'in', `(${currentLetters.map(l => `"${l}"`).join(',')})`)
  } else {
    await supabaseAdmin.from('court_notes').delete().eq('week_id', dayWeekId).eq('session_date', daySessionDate)
  }

  // Read confirmed assignments for email
  const { data: assignments, error: readError } = await supabaseAdmin
    .from('court_assignments')
    .select(`
      court_number, court_letter, team_number, partner_setting,
      assignment_status, location_id, session_id,
      players ( id, first_name, last_name, email, signup_token ),
      locations ( name )
    `)
    .in('session_id', sessionIds)
    .eq('assignment_status', 'confirmed')

  if (readError) {
    return Response.json({ status: 'error', message: `Could not read assignments: ${readError.message}` }, { status: 500 })
  }

  // Build rotation/note lookups for email
  const { data: dayRotations } = await supabaseAdmin
    .from('court_rotations').select('winners_court_letter, second_court_letter, rotation_type')
    .eq('week_id', dayWeekId).eq('session_date', daySessionDate)

  const { data: dayNotes } = await supabaseAdmin
    .from('court_notes').select('court_letter, note')
    .eq('week_id', dayWeekId).eq('session_date', daySessionDate)

  const courtNumberByLetter = {}
  for (const a of assignments) { if (a.court_number != null) courtNumberByLetter[a.court_letter] = a.court_number }

  const rotationLabelByLetter = {}
  for (const r of dayRotations ?? []) {
    const sessionFormatForDay = anchorSession.format ?? 'paired_rotation'
    const partnerText = sessionFormatForDay === 'switch_partners' ? 'Switching partners each set.' : 'Keeping the same partner.'
    const winnersLabel = courtNumberByLetter[r.winners_court_letter] != null ? `Court ${courtNumberByLetter[r.winners_court_letter]}` : `Court ${r.winners_court_letter}`
    const secondLabel  = courtNumberByLetter[r.second_court_letter]  != null ? `Court ${courtNumberByLetter[r.second_court_letter]}`  : `Court ${r.second_court_letter}`
    rotationLabelByLetter[r.winners_court_letter] = `${winnersLabel} (winner's court), rotating with ${secondLabel}. ${partnerText}`
    rotationLabelByLetter[r.second_court_letter]  = `${secondLabel}, rotating with ${winnersLabel} (winner's court). ${partnerText}`
  }

  const courtNoteByLetter = {}
  for (const n of dayNotes ?? []) courtNoteByLetter[n.court_letter] = n.note

  const hasMissingNumbers = assignments.some(a => a.court_number == null)
  const sessionDateLabel = formatSessionDateLabel(anchorSession.session_date)
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  let courtsSent = 0

  if (!hasMissingNumbers && assignments.length > 0) {
    const emailPayloads = assignments.map(a => {
      const playerSession = daySessions.find(s => s.id === a.session_id)
      return {
        playerFirstName: a.players.first_name, playerEmail: a.players.email,
        sessionDate: sessionDateLabel, startTime: formatStartTime(playerSession?.start_time),
        locationName: a.locations?.name ?? 'TBD', courtNumber: a.court_number,
        notes: playerSession?.notes ?? null,
        rotationLabel: rotationLabelByLetter[a.court_letter] ?? null,
        courtNote: courtNoteByLetter[a.court_letter] ?? null,
        cancelUrl: `${baseUrl}/portal/${a.players.signup_token}`,
      }
    })
    const { sent } = await sendCourtAssignmentDetailsFull(emailPayloads)
    courtsSent = sent
  } else if (assignments.length > 0) {
    const emailPayloads = assignments.map(a => {
      const playerSession = daySessions.find(s => s.id === a.session_id)
      return {
        playerFirstName: a.players.first_name, playerEmail: a.players.email,
        sessionDate: sessionDateLabel, startTime: formatStartTime(playerSession?.start_time),
        locationName: a.locations?.name ?? 'TBD', notes: playerSession?.notes ?? null,
        cancelUrl: `${baseUrl}/portal/${a.players.signup_token}`,
      }
    })
    const { sent } = await sendCourtAssignmentDetails(emailPayloads)
    courtsSent = sent
  }

  // Finalise timestamps
  const now = new Date().toISOString()
  const { error: finaliseError } = await supabaseAdmin
    .from('sessions')
    .update({ court_assignment_approved_at: now, court_assignment_sent_at: now })
    .in('id', sessionIds)

  if (finaliseError) {
    return Response.json({
      status: 'ok', courtsSent, cancelledCount,
      warning: 'Emails sent but failed to set court_assignment_sent_at — 8pm backstop may re-fire. Manual review required.',
    })
  }

  const responseBody = {
    status: 'ok', courtsSent, cancelledCount,
    rotationsSaved: rotations?.length ?? 0, notesSaved: courtNotes?.length ?? 0,
    newSessionsCreated: placeholderToRealSessionId.size,
  }
  if (hasMissingNumbers) {
    responseBody.warning = 'Some courts are missing court numbers. Players have been sent session details only. Update court numbers and re-approve, or players will receive "check the posted sheet" message if the 8pm backstop fires.'
  }
  return Response.json(responseBody)
}

function formatSessionDateLabel(sessionDate) {
  const date = new Date(sessionDate + 'T12:00:00Z')
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

function formatStartTime(startTime) {
  if (!startTime) return 'TBD'
  return new Date(`1970-01-01T${startTime}Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' })
}