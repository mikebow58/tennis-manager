/**
 * /api/admin/availability
 *
 * Admin-only availability management. Protected by auth middleware —
 * requires an authenticated session. No signup_token validation.
 *
 * POST: Add a player to a session (organiser manual add).
 * DELETE: Remove a player from a session (organiser manual remove).
 *
 * Distinct from /api/availability which is player-facing and requires
 * signup_token validation. Never merge these two routes.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request) {
  try {
    const body = await request.json()

    // body is an array of availability records: [{ session_id, player_id, status }]
    if (!Array.isArray(body) || body.length === 0) {
      return Response.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('availability')
      .insert(body)

    if (error) {
      console.error('[api/admin/availability] Insert error:', error.message)
      return Response.json({ error: 'Error adding availability' }, { status: 500 })
    }

    return Response.json({ success: true })
  } catch (err) {
    console.error('[api/admin/availability] Unexpected error:', err)
    return Response.json({ error: 'Unexpected error' }, { status: 500 })
  }
}

export async function DELETE(request) {
  try {
    const { availabilityId } = await request.json()

    if (!availabilityId) {
      return Response.json({ error: 'availabilityId required' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('id', availabilityId)

    if (error) {
      console.error('[api/admin/availability] Delete error:', error.message)
      return Response.json({ error: 'Error removing availability' }, { status: 500 })
    }

    return Response.json({ success: true })
  } catch (err) {
    console.error('[api/admin/availability] Unexpected error:', err)
    return Response.json({ error: 'Unexpected error' }, { status: 500 })
  }
}