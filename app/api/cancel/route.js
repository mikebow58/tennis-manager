import { supabase } from '@/lib/supabase'
import { sendCancellationNotice } from '@/lib/email'

export async function POST(request) {
  const { availabilityId, playerId, sessionId } = await request.json()

  const { data: player } = await supabase
    .from('players')
    .select('first_name, last_name')
    .eq('id', playerId)
    .single()

  const { data: session } = await supabase
    .from('sessions')
    .select('session_date, location')
    .eq('id', sessionId)
    .single()

  const { error } = await supabase
  .from('availability')
  .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
  .eq('id', availabilityId)

  if (error) {
    return Response.json({ error: 'Error cancelling' }, { status: 500 })
  }

  const sessionDate = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })

  await sendCancellationNotice({
    adminEmail: process.env.ADMIN_EMAIL,
    playerName: `${player.first_name} ${player.last_name}`,
    sessionDate,
    location: session.location
  })

  return Response.json({ success: true })
}