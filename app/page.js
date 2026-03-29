import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import SendSignupButton from './SendSignupButton'

export default async function Dashboard() {
  const { data: weeks } = await supabase
    .from('weeks')
    .select('*')
    .eq('status', 'open')
    .order('start_date', { ascending: true })
    .limit(1)

  const week = weeks?.[0] || null

  let sessions = []
  let sessionIds = []

  if (week) {
    const { data } = await supabase
      .from('sessions')
      .select('*')
      .eq('week_id', week.id)
      .order('session_date', { ascending: true })
    sessions = data || []
    sessionIds = sessions.map(s => s.id)
  }

  let availabilityCounts = {}

  if (sessionIds.length > 0) {
    const { data: availability } = await supabase
      .from('availability')
      .select('session_id, player_id')
      .in('session_id', sessionIds)

    if (availability) {
      availability.forEach(({ session_id }) => {
        availabilityCounts[session_id] = (availabilityCounts[session_id] || 0) + 1
      })
    }
  }

  const { data: allPlayers } = await supabase
    .from('players')
    .select('id')
    .eq('active', true)

  const totalPlayers = allPlayers?.length || 0

  const playersWithSignup = new Set()
  if (sessionIds.length > 0) {
    const { data: availability } = await supabase
      .from('availability')
      .select('player_id')
      .in('session_id', sessionIds)
    availability?.forEach(a => playersWithSignup.add(a.player_id))
  }

  const weekLabel = week
    ? new Date(week.start_date).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      })
    : null

  const shortCount = sessions.filter(s => {
  const count = availabilityCounts[s.id] || 0
  return count === 0 || count % 4 !== 0
}).length

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">

      {!week ? (
        <div className="text-center py-16">
          <p className="text-gray-500 mb-4">No open weeks found.</p>
          <Link href="/weeks/new" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">Create a week</Link>
        </div>
      ) : (
        <>
          <div className="flex justify-between items-start mb-6">
  <div>
    <h1 className="text-xl md:text-2xl font-semibold text-gray-900">Dashboard</h1>
    <p className="text-sm text-gray-500 mt-0.5">Week of {weekLabel}</p>
  </div>
  <div className="flex flex-col items-end gap-2">
    <Link href="/weeks" className="text-sm text-gray-500 hover:text-gray-700">All weeks</Link>
    <SendSignupButton weekId={week.id} signupSentAt={week.signup_sent_at} />
  </div>
</div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-1">Active players</div>
              <div className="text-2xl font-semibold text-gray-900">{totalPlayers}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-1">Responded</div>
              <div className="text-2xl font-semibold text-green-600">{playersWithSignup.size}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-1">Courts short</div>
              <div className={`text-2xl font-semibold ${shortCount > 0 ? 'text-amber-500' : 'text-gray-900'}`}>{shortCount}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-1">Cancellations</div>
              <div className="text-2xl font-semibold text-gray-900">0</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
            {sessions.map((session) => {
              const count = availabilityCounts[session.id] || 0
             const isFull = count > 0 && count % 4 === 0
              const isEmpty = count === 0
              const isShort = !isFull

              const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC'
              })

              const spotsNeeded = isFull ? 0 : (Math.ceil(count / 4) * 4) - count

              return (
                <Link
                  key={session.id}
                  href={`/weeks/${week.id}/sessions/${session.id}`}
                  className={`block border rounded-xl p-4 hover:bg-gray-50 transition-colors ${
                    isFull ? 'border-green-300' :
                    isShort ? 'border-amber-300' :
                    'border-gray-200'
                  }`}
                >
                  <div className="flex justify-between items-start mb-3">
                    <div className="font-medium text-sm text-gray-900">{dateLabel}</div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      isFull ? 'bg-green-100 text-green-700' :
                      isShort ? 'bg-amber-100 text-amber-700' :
                      'bg-gray-100 text-gray-500'
                    }`}>
                      {isFull ? 'Full' : isEmpty ? '0 signups' : `${spotsNeeded} short`}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mb-3">
                    {session.start_time} · {session.location}
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-700">
                      {count} player{count !== 1 ? 's' : ''}
                    </span>
                    <span className="text-xs text-gray-400">
                      {session.court_count} {session.court_count === 1 ? 'court' : 'courts'}
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>

          <div className="bg-gray-50 rounded-xl p-4">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Reminders</div>
            <div className="space-y-2">
              {sessions.map((session) => {
                const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
                  weekday: 'long',
                  timeZone: 'UTC'
                })
                return (
                  <div key={session.id} className="flex justify-between items-center text-sm">
                    <span className="text-gray-700">{dateLabel}</span>
                    <span className="text-gray-400 text-xs">Not yet sent</span>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}