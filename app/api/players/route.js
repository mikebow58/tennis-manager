import { supabaseAdmin as supabase } from '@/lib/supabase-admin'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const active = searchParams.get('active') !== 'false'
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('active', active)
    .order('last_name', { ascending: true })
  if (error) return Response.json([], { status: 500 })
  return Response.json(data)
}