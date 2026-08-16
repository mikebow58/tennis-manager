import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import SignupForm from './SignupForm'

export default async function SignupPage({ params }) {
  const { token } = params

  // BUG FIX (post-beta item #11): .eq('active', true) added so a
  // deactivated player's old signup link no longer resolves to a valid
  // player record. See item #11 discussion for the full history.
  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name, last_name, signup_token')
    .eq('signup_token', token)
    .eq('active', true)
    .single()

  if (playerError || !player) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500 mb-4">This signup link is invalid or has expired.</p>
        <a href="/contact" className="text-sm text-blue-600 hover:underline">
          Need help? Contact us
        </a>
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

  // Post-beta item #6 — "I'm out this week." Whole-week, non-rescindable
  // opt-out. If this player already opted out of the current signup week,
  // short-circuit straight to a static message — no day-picker, no undo.
  // See app/api/signup/[token]/opt-out/route.js for the write path.
  let optedOut = false
  if (currentWeek) {
    const { data: optOutRow } = await supabase
      .from('weekly_opt_outs')
      .select('id')
      .eq('player_id', player.id)
      .eq('week_id', currentWeek.id)
      .maybeSingle()
    optedOut = !!optOutRow
  }

  if (optedOut) {
    return (
      <div className="max-w-md mx-auto p-6 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
        <p className="text-sm text-gray-500 mt-6">
          You're marked as out this week. We'll see you next week!
        </p>
        <div className="mt-8 pt-4 border-t border-gray-100 text-center">
          <a href={`/contact/${token}`} className="text-xs text-gray-400 hover:text-gray-600">
            Having trouble with this page? Let us know
          </a>
        </div>
      </div>
    )
  }

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

      {/* Post-beta item #9 — player-to-organizer messaging footer link. */}
      <div className="mt-8 pt-4 border-t border-gray-100 text-center">
        <a href={`/contact/${token}`} className="text-xs text-gray-400 hover:text-gray-600">
          Having trouble with this page? Let us know
        </a>
      </div>
    </div>
  )
}