import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request) {
  const body = await request.json()
  const { data: week, error } = await supabaseAdmin
    .from('weeks')
    .insert([body])
    .select()
    .single()
  if (error) return Response.json({ error: 'Error creating week' }, { status: 500 })
  return Response.json(week)
}