// app/api/sessions/[sessionId]/route.js
//
// GET    /api/sessions/[sessionId]  — returns the full session record.
// PATCH  /api/sessions/[sessionId]  — updates an explicit whitelist of
//        editable fields. Called by two known client components:
//        app/weeks/[id]/sessions/[sessionId]/edit/EditSessionClient.js and
//        app/admin/weeks/[id]/approve/ApproveWeekClient.js (verified via
//        grep — no other caller exists as of this revision).
// DELETE /api/sessions/[sessionId]  — deletes the session and its
//        associated availability records.
//
// WHITELIST ADDED THIS REVISION: previously this route did a blind
// `.update(body)` with no field validation — same pattern found (and fixed)
// on the players route. Not actively broken here, since both known callers
// only ever sent real column names, but adding organiser_notes support was
// a natural point to lock this down the same way, rather than add one more
// field to an unprotected passthrough.

import { supabaseAdmin } from '@/lib/supabase-admin'

// Fields this route is allowed to write. Confirmed against both known
// callers (EditSessionClient.js, ApproveWeekClient.js) via grep — if a new
// caller needs to update a different field, add it here explicitly rather
// than reverting to a blind update.
const EDITABLE_FIELDS = [
  'start_time',
  'location_id',
  'courts_available',
  'format',
  'notes',
  'organiser_notes',
]

export async function GET(request, { params }) {
  const { sessionId } = await params
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single()
  if (error) return Response.json({ error: 'Session not found' }, { status: 404 })
  return Response.json(data)
}

export async function PATCH(request, { params }) {
  const { sessionId } = await params
  const body = await request.json()

  // Build the update payload from only whitelisted fields present in the
  // request body — anything else is silently dropped rather than sent to
  // the database.
  const updatePayload = {}
  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updatePayload[field] = body[field]
    }
  }

  if (Object.keys(updatePayload).length === 0) {
    return Response.json({ success: true, updated: [] })
  }

  const { error } = await supabaseAdmin
    .from('sessions')
    .update(updatePayload)
    .eq('id', sessionId)

  if (error) return Response.json({ error: 'Error updating session' }, { status: 500 })
  return Response.json({ success: true, updated: Object.keys(updatePayload) })
}

export async function DELETE(request, { params }) {
  const { sessionId } = await params
  await supabaseAdmin
    .from('availability')
    .delete()
    .eq('session_id', sessionId)
  const { error } = await supabaseAdmin
    .from('sessions')
    .delete()
    .eq('id', sessionId)
  if (error) return Response.json({ error: 'Error deleting session' }, { status: 500 })
  return Response.json({ success: true })
}