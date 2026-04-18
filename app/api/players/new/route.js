import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request) {
  const body = await request.json()
  const { error } = await supabaseAdmin
    .from('players')
    .insert([body])
  if (error) return Response.json({ error: 'Error creating player' }, { status: 500 })
  return Response.json({ success: true })
}