import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { formatTime } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function WeekPage({ params }) {
  const { id } = await params

  const { data: week, error: weekError } = await supabase
    .from('weeks')
    .select('*')
    .eq('id', id)
    .single()

  if (weekError) {
    console.error(weekError)
    return <div>Error loading week.</div>
  }

  const { data: sessions, error: sessionsError } = await supabase
    .from('sessions')
    .select('*')
    .eq('week_id', id)
    .order('session_date', { ascending: true })

  if (sessionsError) {
    console.error(sessionsError)
    return <div>Error loading sessions.</div>
  }

  const weekLabel = new Date(week.start_date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-3xl mx-auto">
          <a href="/weeks" className="text-xs text-slate-400 hover:text-slate-200 mb-2 inline-block">← Weeks</a>
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-xl font-semibold text-white">Week of {weekLabel}</h1>
              <p className="text-xs text-slate-300 mt-0.5 capitalize">Status: {week.status}</p>
            </div>
            <a href={`/weeks/${id}/sessions/new`} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">Add session</a>
          </div>
        </div>
      </div>

      <div className="px-4 md:px-8 py-4 max-w-3xl mx-auto">
        {sessions.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-8 text-center text-sm text-gray-400">
            No sessions yet. Add the play days for this week.
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => {
              const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                timeZone: 'UTC'
              })
              return (
                <div key={session.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex justify-between items-center">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{dateLabel}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {formatTime(session.start_time)} · {session.location} · {session.court_count} {session.court_count === 1 ? 'court' : 'courts'}
                    </div>
                  </div>
                  <a href={`/weeks/${id}/sessions/${session.id}`} className="text-sm text-blue-600 hover:underline ml-4">Manage</a>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}