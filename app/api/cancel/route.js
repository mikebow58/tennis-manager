import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { sendCancellationNotice } from '@/lib/email'

export async function POST(request) {
  const { availabilityId, playerId, sessionId } = await request.json()

  console.log('Cancel route hit', { availabilityId, playerId, sessionId })

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('first_name, last_name')
    .eq('id', playerId)
    .single()

  console.log('Player lookup:', { player, playerError })

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('session_date, location')
    .eq('id', sessionId)
    .single()

  console.log('Session lookup:', { session, sessionError })

  const { error } = await supabase
    .from('availability')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', availabilityId)

  console.log('Availability update error:', error)

  if (error) {
    return Response.json({ error: 'Error cancelling' }, { status: 500 })
  }

  const sessionDate = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })

  console.log('About to send cancellation notice to:', process.env.ADMIN_EMAIL)

  await sendCancellationNotice({
    adminEmail: process.env.ADMIN_EMAIL,
    playerName: `${player.first_name} ${player.last_name}`,
    sessionDate,
    location: session.location
  })

  console.log('Cancellation notice sent')

  return Response.json({ success: true })
}