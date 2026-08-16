import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import CancelForm from './CancelForm'
import { formatTime } from '@/lib/utils'

export default async function CancelPage({ params }) {
  const { token, sessionId } = await params

  // BUG FIX (this revision): this query previously matched on signup_token
  // alone, with no active check — the same gap that was fixed on the
  // signup page in post-beta item #11. Adding .eq('active', true) closes
  // it here too: a deactivated player's old cancellation link no longer
  // resolves to a valid player record.
  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name')
    .eq('signup_token', token)
    .eq('active', true)
    .single()

  if (playerError || !player) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500 mb-4">This cancellation link is invalid.</p>
        <a href="/contact" className="text-sm text-blue-600 hover:underline">
          Need help? Contact us
        </a>
      </div>
    )
  }

  const { data: session, error: sessionError } = await supabase
  .from('sessions')
  .select('*, locations ( name )')
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

  const { data: activeAvailability } = await supabase
    .from('availability')
    .select('id')
    .eq('session_id', sessionId)
    .in('status', ['confirmed', 'tentative'])

  const playerCount = activeAvailability?.length || 0
  const postCancelCount = Math.max(0, playerCount - 1)
  const willLeaveShort = postCancelCount % 4 !== 0


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
        <div className="font-medium text-gray-900">{formatTime(session.start_time)} · {session.locations?.name ?? 'TBD'}</div>
      </div>

      <CancelForm
        playerId={player.id}
        playerName={player.first_name}
        sessionId={sessionId}
        availabilityId={availability.id}
        playerCount={playerCount ?? 0}
        signupToken={token}
        willLeaveShort={willLeaveShort}
      />

      {/* Post-beta item #9 — player-to-organizer messaging footer link. */}
      <div className="mt-8 pt-4 border-t border-gray-100 text-center">
        <a href={`/contact/${token}`} className="text-xs text-gray-400 hover:text-gray-600">
          Having trouble with this page? Let us know
        </a>
      </div>
    </div>
  )
}