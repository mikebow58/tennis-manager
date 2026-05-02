import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request) {
  const body = await request.json()
  console.log('POST BODY:', body)

  const { data, error } = await supabaseAdmin
    .from('availability')
    .insert(body)

  if (error) {
    console.error('INSERT ERROR:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ success: true })
}

export async function DELETE(request) {
  const { playerId, sessionIds, availabilityId } = await request.json()
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