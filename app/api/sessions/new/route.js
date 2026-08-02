// app/api/sessions/new/route.js
//
// POST /api/sessions/new — creates a new session record. Called exclusively
// by app/weeks/[id]/sessions/new/NewSessionClient.js (confirmed via grep —
// no other caller exists as of this revision).
//
// WHITELIST ADDED THIS REVISION: previously did a blind
// `.insert([body])` with no field validation — same pattern found and
// fixed on the players and session-edit routes. Locked down here too while
// adding organiser_notes support, for the same reason: a stray or renamed
// client field should be silently ignored rather than break the insert or
// (worse, for an insert) write an unintended column.

import { supabaseAdmin } from '@/lib/supabase-admin'

// Fields this route accepts on creation. Confirmed against the single known
// caller (NewSessionClient.js) — if a new caller needs a different field,
// add it here explicitly rather than reverting to a blind insert.
const CREATABLE_FIELDS = [
  'week_id',
  'session_date',
  'start_time',
  'location_id',
  'courts_available',
  'format',
  'notes',
  'organiser_notes',
  'status',
]

export async function POST(request) {
  const body = await request.json()

  const insertPayload = {}
  for (const field of CREATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      insertPayload[field] = body[field]
    }
  }

  const { error } = await supabaseAdmin
    .from('sessions')
    .insert([insertPayload])

  if (error) return Response.json({ error: 'Error creating session' }, { status: 500 })
  return Response.json({ success: true })
}