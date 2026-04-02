import { supabase } from '@/lib/supabase'
import SendReminderButton from '@/app/SendReminderButton'

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

  const playerCount = availability.length
  const courtCount = session.court_count
  const spotsNeeded = (Math.ceil(playerCount / 4) * 4) - playerCount
  const isFull = playerCount > 0 && playerCount % 4 === 0

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex justify-between items-center mb-2">
        <h1 className="text-2xl font-semibold">{sessionLabel}</h1>
        <a href={`/weeks/${id}`} className="text-sm text-gray-500 hover:text-gray-700">Back to week</a>
      </div>

      <div className="grid grid-cols-2 md:flex md:gap-6 gap-y-2 text-sm text-gray-500 mb-6">
  <span>{session.start_time ? session.start_time.slice(0, 5) : ''}</span>
  <span>{session.location}</span>
  <span>{courtCount} {courtCount === 1 ? 'court' : 'courts'}</span>
  <span className="capitalize">{session.format.replace(/_/g, ' ')}</span>
  <a href={`/weeks/${id}/sessions/${sessionId}/edit`} className="text-blue-600 hover:underline col-span-2 md:col-span-1">Edit</a>
</div>

      {session.notes && (
        <div className="bg-amber-50 border border-amber-200 rounded px-4 py-3 text-sm text-amber-800 mb-6">
          {session.notes}
        </div>
      )}

      <div className="flex justify-between items-center mb-4">
  <div className="flex items-center gap-4">
    <h2 className="text-lg font-medium">Players</h2>
    <span className={`text-xs px-2 py-1 rounded-full font-medium ${
      isFull
        ? 'bg-green-100 text-green-700'
        : playerCount === 0
        ? 'bg-gray-100 text-gray-500'
        : 'bg-amber-100 text-amber-700'
    }`}>
      {playerCount} signed up
      {!isFull && playerCount > 0 && ` · needs ${spotsNeeded} more`}
      {isFull && ' · full'}
    </span>
  </div>
  <div className="flex items-center gap-3">
    <SendReminderButton
      sessionId={sessionId}
      reminderSentAt={session.reminder_sent_at}
      playerCount={playerCount}
    />
    <a href={`/weeks/${id}/sessions/${sessionId}/add-player`} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">Add player</a>
  </div>
</div>

      {availability.length === 0 ? (
        <p className="text-gray-500 text-sm">No players signed up yet.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-left text-sm text-gray-500">
              <th className="pb-3 pr-6">Name</th>
              <th className="pb-3 pr-6">Gender</th>
              <th className="pb-3 pr-6">Skill</th>
              <th className="pb-3 pr-6">Type</th>
              <th className="pb-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {availability.map((entry) => (
              <tr key={entry.id} className="border-b border-gray-100 text-sm hover:bg-gray-50">
                <td className="py-3 pr-6 font-medium">
                  {entry.players.first_name} {entry.players.last_name}
                </td>
                <td className="py-3 pr-6 text-gray-600">{entry.players.gender}</td>
                <td className="py-3 pr-6 text-gray-600">{entry.players.skill_admin}</td>
                <td className="py-3 pr-6 text-gray-600 capitalize">{entry.players.player_type}</td>
                <td className="py-3 text-gray-600 capitalize">{entry.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}