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
  const playersWithSignup = new Set()

  if (sessionIds.length > 0) {
    const { data: availability } = await supabase
      .from('availability')
      .select('session_id, player_id')
      .in('session_id', sessionIds)

    if (availability) {
      availability.forEach(({ session_id, player_id }) => {
        availabilityCounts[session_id] = (availabilityCounts[session_id] || 0) + 1
        playersWithSignup.add(player_id)
      })
    }
  }

  const { data: allPlayers } = await supabase
    .from('players')
    .select('id')
    .eq('active', true)

  const totalPlayers = allPlayers?.length || 0

  const shortCount = sessions.filter(s => {
    const count = availabilityCounts[s.id] || 0
    return count === 0 || count % 4 !== 0
  }).length

  const weekLabel = week
    ? new Date(week.start_date).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      })
    : null

  const sentLabel = week?.signup_sent_at
    ? new Date(week.signup_sent_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : null

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      {!week ? (
        <div className="text-center py-16">
          <p className="text-gray-500 mb-4">No open weeks found.</p>
          <Link href="/weeks/new" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">Create a week</Link>
        </div>
      ) : (
        <>
          <div className="bg-[#0f172a] px-4 md:px-8 pt-5 pb-4">
            <div className="max-w-5xl mx-auto">

              <div className="flex justify-between items-start mb-4">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold text-white">Dashboard</h1>
                  <p className="text-xs text-slate-300 mt-0.5">Week of {weekLabel}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Active players</div>
                  <div className="text-2xl font-medium text-slate-900">{totalPlayers}</div>
                </div>
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Responded</div>
                  <div className="text-2xl font-medium text-green-700">{playersWithSignup.size}</div>
                </div>
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Courts short</div>
                  <div className={`text-2xl font-medium ${shortCount > 0 ? 'text-amber-600' : 'text-slate-900'}`}>{shortCount}</div>
                </div>
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Cancellations</div>
                  <div className="text-2xl font-medium text-slate-900">0</div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-3">
  {week.signup_sent_at ? (
    <div className="flex justify-between items-center max-w-xs">
      <span className="text-xs font-medium text-emerald-400">Signup requests sent</span>
      <span className="text-xs text-slate-300">{sentLabel}</span>
    </div>
                ) : (
                  <SendSignupButton weekId={week.id} signupSentAt={week.signup_sent_at} />
                )}
              </div>

            </div>
          </div>

          <div className="px-4 md:px-8 pt-4 pb-6 max-w-5xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
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
                    className={`block rounded-xl p-4 transition-opacity hover:opacity-90 ${
                      isFull ? 'bg-green-50 border border-green-200' :
                      isShort && !isEmpty ? 'bg-amber-50 border border-amber-200' :
                      'bg-white border border-gray-200'
                    }`}
                  >
                    <div className={`text-sm font-medium mb-1 ${
                      isFull ? 'text-green-900' :
                      isShort && !isEmpty ? 'text-amber-900' :
                      'text-gray-900'
                    }`}>
                      {dateLabel}
                    </div>
                    <div className="text-xs text-gray-400 mb-3">
                      {session.start_time} · {session.location}
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-400">
                        {isEmpty ? `${session.court_count} ${session.court_count === 1 ? 'court' : 'courts'}` : `${count} player${count !== 1 ? 's' : ''} · ${session.court_count} ${session.court_count === 1 ? 'court' : 'courts'}`}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        isFull ? 'bg-green-600 text-white' :
                        isShort && !isEmpty ? 'bg-amber-500 text-white' :
                        'bg-gray-500 text-white'
                      }`}>
                        {isFull ? 'Full' : isEmpty ? 'Open' : `${spotsNeeded} short`}
                      </span>
                    </div>
                  </Link>
                )
              })}
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Reminders</div>
              <div className="space-y-2">
                {sessions.map((session) => {
                  const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
                    weekday: 'long',
                    timeZone: 'UTC'
                  })
                  return (
                    <div key={session.id} className="flex justify-between items-center text-sm">
                      <span className="text-gray-700 text-xs">{dateLabel}</span>
                      <span className={`text-xs ${session.reminder_sent_at ? 'text-green-600' : 'text-gray-400'}`}>
                        {session.reminder_sent_at
                          ? `Sent · ${new Date(session.reminder_sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                          : 'Not yet sent'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}