import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(request, { params }) {
  const { id } = await params
  const { data, error } = await supabaseAdmin
    .from('players')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return Response.json({ error: 'Player not found' }, { status: 404 })
  return Response.json(data)
}

export async function PATCH(request, { params }) {
  const { id } = await params
  const body = await request.json()
  const { error } = await supabaseAdmin
    .from('players')
    .update(body)
    .eq('id', id)
  if (error) return Response.json({ error: 'Error updating player' }, { status: 500 })
  return Response.json({ success: true })
}

export async function DELETE(request, { params }) {
  const { id } = await params
  const { error } = await supabaseAdmin
    .from('players')
    .delete()
    .eq('id', id)
  if (error) return Response.json({ error: 'Error deleting player' }, { status: 500 })
  return Response.json({ success: true })
}