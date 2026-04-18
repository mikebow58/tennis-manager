import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import SendReminderButton from '@/app/SendReminderButton'
import RemovePlayerButton from './RemovePlayerButton'
import { formatTime, getSkillLabel } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function SessionPage({ params }) {
  const { id, sessionId } = await params

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (sessionError) {
    console.error(sessionError)
    return <div>Error loading session.</div>
  }

  const { data: availability, error: availError } = await supabase
    .from('availability')
    .select('*, players(id, first_name, last_name, gender, skill_admin, player_type)')
    .eq('session_id', sessionId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: true })

  if (availError) {
    console.error(availError)
    return <div>Error loading availability.</div>
  }

  const sessionLabel = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })

  const shortLabel = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })

  const playerCount = availability.length
  const courtCount = session.court_count
  const spotsNeeded = (Math.ceil(playerCount / 4) * 4) - playerCount
  const isFull = playerCount > 0 && playerCount % 4 === 0

  const reminderSentLabel = session.reminder_sent_at
    ? new Date(session.reminder_sent_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Denver'
      })
    : null

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-3xl mx-auto">
          <a href={`/weeks/${id}`} className="text-xs text-slate-400 hover:text-slate-200 mb-2 inline-block">← Back to week</a>
          <h1 className="text-xl font-semibold text-white">{shortLabel}</h1>
          <p className="text-xs text-slate-300 mt-0.5">Week of {new Date(session.session_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</p>
        </div>
      </div>

      <div className="px-4 md:px-8 py-4 max-w-3xl mx-auto space-y-4">

        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="bg-gray-50 border-b border-gray-200 px-4 py-3 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-900">Session info</span>
            <a href={`/weeks/${id}/sessions/${sessionId}/edit`} className="text-xs text-blue-600 hover:underline">Edit</a>
          </div>
          <div className="px-4 py-3 grid grid-cols-2 gap-y-2">
            <div>
              <div className="text-xs text-gray-500">Time</div>
              <div className="text-sm font-medium text-gray-900">{formatTime(session.start_time)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Location</div>
              <div className="text-sm font-medium text-gray-900">{session.location}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Courts</div>
              <div className="text-sm font-medium text-gray-900">{courtCount}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Format</div>
              <div className="text-sm font-medium text-gray-900 capitalize">{session.format.replace(/_/g, ' ')}</div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-2">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-medium text-gray-900">Players</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                isFull ? 'bg-green-100 text-green-700' :
                playerCount === 0 ? 'bg-gray-100 text-gray-500' :
                'bg-amber-100 text-amber-700'
              }`}>
                {playerCount} signed up
                {!isFull && playerCount > 0 && ` · needs ${spotsNeeded} more`}
                {isFull && ' · full'}
              </span>
            </div>
            <a href={`/weeks/${id}/sessions/${sessionId}/add-player`} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 text-xs font-medium">Add player</a>
          </div>

          {availability.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-6 text-center text-sm text-gray-400">
              No players signed up yet.
            </div>
          ) : (
            <div className="space-y-2">
              {availability.map((entry) => (
                <div key={entry.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-900">
                      {entry.players.last_name}, {entry.players.first_name}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {getSkillLabel(entry.players.skill_admin)} · {entry.players.gender === 'M' ? 'Male' : entry.players.gender === 'F' ? 'Female' : entry.players.gender} · <span className="capitalize">{entry.players.player_type}</span>
                    </div>
                  </div>
                  <RemovePlayerButton
                    availabilityId={entry.id}
                    playerName={`${entry.players.first_name} ${entry.players.last_name}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="bg-gray-50 border-b border-gray-200 px-4 py-3 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-900">Reminders & Notes</span>
            <a href={`/weeks/${id}/sessions/${sessionId}/edit`} className="text-xs text-blue-600 hover:underline">Edit</a>
          </div>
          <div className="px-4 py-3 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-500">Reminder</span>
              {reminderSentLabel ? (
                <span className="text-xs text-green-600 font-medium">Sent · {reminderSentLabel}</span>
              ) : (
                <SendReminderButton
                  sessionId={sessionId}
                  reminderSentAt={session.reminder_sent_at}
                  playerCount={playerCount}
                />
              )}
            </div>
            {session.notes && (
              <div className="flex justify-between items-start gap-4">
                <span className="text-xs text-gray-500 flex-shrink-0">Note</span>
                <span className="text-xs text-gray-600 italic text-right">{session.notes}</span>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}