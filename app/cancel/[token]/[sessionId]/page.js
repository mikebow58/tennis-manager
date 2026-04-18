import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import CancelForm from './CancelForm'
import { formatTime } from '@/lib/utils'

export default async function CancelPage({ params }) {
  const { token, sessionId } = await params

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name')
    .eq('signup_token', token)
    .single()

  if (playerError || !player) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500">This cancellation link is invalid.</p>
      </div>
    )
  }

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500">Session not found.</p>
      </div>
    )
  }

  const { data: availability } = await supabase
    .from('availability')
    .select('id')
    .eq('session_id', sessionId)
    .eq('player_id', player.id)
    .single()

  if (!availability) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500">You are not signed up for this session.</p>
      </div>
    )
  }

  const { data: allAvailability } = await supabase
    .from('availability')
    .select('id')
    .eq('session_id', sessionId)

  const playerCount = allAvailability?.length || 0

  const sessionDate = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Cancel your spot?
        </h1>
        <p className="text-sm text-gray-500">{sessionDate}</p>
      </div>

      <div className="bg-gray-50 rounded-xl p-4 mb-6">
        <div className="text-sm text-gray-600 mb-1">Session details</div>
        <div className="font-medium text-gray-900">{formatTime(session.start_time)} · {session.location}</div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-8">
        <div className="text-sm text-amber-800">
          There are currently <strong>{playerCount} players</strong> signed up for this session. 
          Cancelling will leave the court short and the organizer will be notified.
        </div>
      </div>

      <CancelForm
        playerId={player.id}
        playerName={player.first_name}
        sessionId={sessionId}
        availabilityId={availability.id}
      />
    </div>
  )
}