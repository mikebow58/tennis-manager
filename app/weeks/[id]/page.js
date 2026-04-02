import { supabase } from '@/lib/supabase'
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
    <div className="p-8">
      <div className="flex justify-between items-center mb-2">
        <h1 className="text-2xl font-semibold">Week of {weekLabel}</h1>
      </div>

      <p className="text-sm text-gray-500 capitalize mb-8">Status: {week.status}</p>

      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-medium">Sessions</h2>
        <a href={`/weeks/${id}/sessions/new`} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">Add session</a>
      </div>

      {sessions.length === 0 ? (
        <p className="text-gray-500 text-sm">No sessions yet. Add the play days for this week.</p>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <div key={session.id} className="border border-gray-200 rounded-lg p-4 flex justify-between items-center hover:bg-gray-50">
              <div>
                <div className="font-medium text-sm">
                  {new Date(session.session_date).toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'UTC'
                  })}
                </div>
                <div className="text-xs text-gray-500 mt-1">
  {formatTime(session.start_time)} · {session.location} · {session.court_count} {session.court_count === 1 ? 'court' : 'courts'}
</div>
              </div>
              <div className="flex items-center gap-4">
  <a href={`/weeks/${id}/sessions/${session.id}`} className="text-sm text-blue-600 hover:underline">Manage</a>
</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}