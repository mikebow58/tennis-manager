import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request) {
  const body = await request.json()
  const { error } = await supabaseAdmin
    .from('sessions')
    .insert([body])
  if (error) return Response.json({ error: 'Error creating session' }, { status: 500 })
  return Response.json({ success: true })
}