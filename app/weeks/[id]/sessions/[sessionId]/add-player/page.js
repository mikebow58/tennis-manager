import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import AddPlayerClient from './AddPlayerClient'

export const dynamic = 'force-dynamic'

export default async function AddPlayerToSessionPage({ params }) {
  const { id, sessionId } = await params

  const [{ data: allPlayers }, { data: existing }] = await Promise.all([
    supabase
      .from('players')
      .select('id, first_name, last_name, gender, skill_admin, player_type')
      .eq('active', true)
      .order('last_name', { ascending: true }),
    supabase
      .from('availability')
      .select('player_id')
      .eq('session_id', sessionId)
      .neq('status', 'cancelled')
  ])

  const existingIds = (existing || []).map(e => e.player_id)

  return (
    <AddPlayerClient
      weekId={id}
      sessionId={sessionId}
      allPlayers={allPlayers || []}
      initialExistingIds={existingIds}
    />
  )
}