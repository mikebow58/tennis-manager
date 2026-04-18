import { supabaseAdmin } from '@/lib/supabase-admin'

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
  const { error } = await supabaseAdmin
    .from('sessions')
    .update(body)
    .eq('id', sessionId)
  if (error) return Response.json({ error: 'Error updating session' }, { status: 500 })
  return Response.json({ success: true })
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