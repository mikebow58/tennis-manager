import { createClient } from '@/lib/supabase-server'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const active = searchParams.get('active') !== 'false'
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('active', active)
    .order('last_name', { ascending: true })
  if (error) return Response.json([], { status: 500 })
  return Response.json(data)
}