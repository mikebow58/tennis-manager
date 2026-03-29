import { supabase } from '@/lib/supabase'
import SignupForm from './SignupForm'

export default async function SignupPage({ params }) {
  const { token } = await params

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name, last_name')
    .eq('signup_token', token)
    .single()

  if (playerError || !player) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <p className="text-gray-500">This signup link is invalid or has expired.</p>
      </div>
    )
  }

  const { data: sessions, error: sessionsError } = await supabase
    .from('sessions')
    .select('*, weeks!inner(status)')
    .eq('weeks.status', 'open')
    .order('session_date', { ascending: true })

  if (sessionsError) {
    console.error(sessionsError)
    return <div className="p-8">Error loading sessions.</div>
  }

  const { data: existing } = await supabase
    .from('availability')
    .select('session_id')
    .eq('player_id', player.id)

  const signedUpSessionIds = existing ? existing.map(e => e.session_id) : []

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
        <p className="text-sm text-gray-500">
          Select the days you want to play this week.
        </p>
      </div>

      <SignupForm
        player={player}
        sessions={sessions}
        signedUpSessionIds={signedUpSessionIds}
      />
    </div>
  )
}