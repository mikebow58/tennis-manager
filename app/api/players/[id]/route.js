// app/api/players/[id]/route.js
//
// GET    /api/players/[id]  — returns the full player record.
// PATCH  /api/players/[id]  — updates an explicit whitelist of editable fields.
// DELETE /api/players/[id]  — hard-deletes the player record.
//
// IMPORTANT — bug fix (see architecture skill Section 13 changelog):
// The previous version of this route ran `supabaseAdmin.from('players').update(body)`
// directly against the raw request body, with no field whitelist. The edit page was
// sending `mobile` and `player_type` — neither of which exists as a column on the V2
// `players` table (the real column is `mobile_number`, and `player_type` was dropped
// entirely in V2). Since PostgREST rejects an UPDATE referencing an unknown column,
// this meant every player edit save was failing outright. Fixed by explicitly
// whitelisting the fields this route accepts, so a stray/renamed client field is
// silently ignored rather than breaking the whole write.
//
// Uses supabaseAdmin (service role) per the standard pattern for API routes —
// this route is reached only from the logged-in organiser's admin pages, but
// player records have no RLS-relevant user session of their own either way.

import { supabaseAdmin } from '@/lib/supabase-admin'

// Fields this route is allowed to write. Anything else in the request body is
// ignored rather than passed through — this is the fix for the bug described above,
// and also a general safety net against future field-name drift between the
// frontend form and the database schema.
const EDITABLE_FIELDS = [
  'first_name',
  'last_name',
  'mobile_number',
  'email',
  'gender',
  'skill_self',
  'skill_admin',
  'active',
  'notes',
  'first_call',
  'unavailable_days',
  'match_type_preferences',
]

/**
 * GET /api/players/[id]
 * Returns the full player record. No field filtering — the edit page needs
 * everything to populate its form.
 */
export async function GET(request, { params }) {
  const { id } = await params
  console.log(`[players/${id}] GET — fetching player`)

  const { data, error } = await supabaseAdmin
    .from('players')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    console.error(`[players/${id}] GET — player not found:`, error.message)
    return Response.json({ error: 'Player not found' }, { status: 404 })
  }

  return Response.json(data)
}

/**
 * PATCH /api/players/[id]
 * Updates only the whitelisted fields present in the request body. Any field
 * not in EDITABLE_FIELDS is silently dropped rather than sent to the database —
 * this is what prevents a stray field name from failing the entire update.
 */
export async function PATCH(request, { params }) {
  const { id } = await params
  const body = await request.json()

  // Build the update payload from only the fields we recognise and that were
  // actually present in the request body.
  const updatePayload = {}
  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updatePayload[field] = body[field]
    }
  }

  console.log(
    `[players/${id}] PATCH — updating fields: ${Object.keys(updatePayload).join(', ') || '(none)'}`
  )

  // Nothing to update — treat as a no-op success rather than an error, since
  // this can legitimately happen if the client sends an empty diff.
  if (Object.keys(updatePayload).length === 0) {
    return Response.json({ success: true, updated: [] })
  }

  const { error } = await supabaseAdmin
    .from('players')
    .update(updatePayload)
    .eq('id', id)

  if (error) {
    console.error(`[players/${id}] PATCH — update failed:`, error.message)
    return Response.json({ error: 'Error updating player' }, { status: 500 })
  }

  return Response.json({ success: true, updated: Object.keys(updatePayload) })
}

/**
 * DELETE /api/players/[id]
 * Hard-deletes the player record. Unchanged from prior behaviour.
 */
export async function DELETE(request, { params }) {
  const { id } = await params
  console.log(`[players/${id}] DELETE — deleting player`)

  const { error } = await supabaseAdmin
    .from('players')
    .delete()
    .eq('id', id)

  if (error) {
    console.error(`[players/${id}] DELETE — delete failed:`, error.message)
    return Response.json({ error: 'Error deleting player' }, { status: 500 })
  }

  return Response.json({ success: true })
}