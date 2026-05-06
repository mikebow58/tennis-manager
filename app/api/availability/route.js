import { supabaseAdmin } from '@/lib/supabase-admin'

async function validateToken(token, playerId) {
  if (!token || !playerId) return false
  const { data } = await supabaseAdmin
    .from('players')
    .select('id')
    .eq('signup_token', token)
    .eq('id', playerId)
    .eq('active', true)
    .single()
  return !!data
}

export async function POST(request) {
  const body = await request.json()

  // body is an array of availability records — grab token and player_id from first item
  const { signup_token, player_id } = body[0] || {}
  const valid = await validateToken(signup_token, player_id)
  if (!valid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  // Strip signup_token before inserting — it's not a db field
  const records = body.map(({ signup_token, ...rest }) => rest)

  const { error } = await supabaseAdmin
    .from('availability')
    .insert(records)
  if (error) return Response.json({ error: 'Error adding availability' }, { status: 500 })
  return Response.json({ success: true })
}

export async function DELETE(request) {
  const { playerId, sessionIds, availabilityId, signup_token } = await request.json()

  const valid = await validateToken(signup_token, playerId)
  if (!valid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  if (availabilityId) {
    const { error } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('id', availabilityId)
    if (error) return Response.json({ error: 'Error removing availability' }, { status: 500 })
  } else {
    const { error } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('player_id', playerId)
      .in('session_id', sessionIds)
    if (error) return Response.json({ error: 'Error removing availability' }, { status: 500 })
  }
  return Response.json({ success: true })
}