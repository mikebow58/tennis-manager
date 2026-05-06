import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import SignupForm from './SignupForm'

export default async function SignupPage({ params }) {
  const { token } = params

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name, last_name, signup_token')
    .eq('signup_token', token)
    .single()

  if (playerError || !player) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500">This signup link is invalid or has expired.</p>
      </div>
    )
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().split('T')[0]

  const { data: currentWeek } = await supabase
    .from('weeks')
    .select('id')
    .eq('status', 'sent')
    .single()

  const openSessions = []

  if (currentWeek) {
    const { data: sessions, error: sessionsError } = await supabase
      .from('sessions')
      .select('*')
      .eq('week_id', currentWeek.id)
      .is('reminder_sent_at', null)
      .is('cancelled_at', null)
      .gte('session_date', todayStr)
      .order('session_date', { ascending: true })

    if (sessionsError) {
      console.error(sessionsError)
      return <div className="p-8">Error loading sessions.</div>
    }

    if (sessions) openSessions.push(...sessions)
  }

  const { data: existing } = await supabase
    .from('availability')
    .select('session_id')
    .eq('player_id', player.id)
    .neq('status', 'cancelled')

  const signedUpSessionIds = existing ? existing.map(e => e.session_id) : []

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
      </div>

      <SignupForm
        player={player}
        sessions={openSessions}
        signedUpSessionIds={signedUpSessionIds}
      />
    </div>
  )
}