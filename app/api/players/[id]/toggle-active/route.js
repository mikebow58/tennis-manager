import { createClient } from '@/lib/supabase-server'

export async function POST(request, { params }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: player } = await supabase
    .from('players').select('active').eq('id', id).single()
  await supabase
    .from('players').update({ active: !player.active }).eq('id', id)
  return Response.json({ success: true })
}