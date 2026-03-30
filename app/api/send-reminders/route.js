import { supabase } from '@/lib/supabase'
import { sendReminder } from '@/lib/email'

export async function POST(request) {
  const { sessionId } = await request.json()

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (sessionError) {
    return Response.json({ error: 'Session not found' }, { status: 404 })
  }

  const sessionDate = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })

  const { data: availability, error: availError } = await supabase
    .from('availability')
    .select('*, players(id, first_name, email, signup_token)')
    .eq('session_id', sessionId)
    .eq('status', 'confirmed')

  if (availError) {
    return Response.json({ error: 'Error fetching players' }, { status: 500 })
  }

  const results = { sent: 0, failed: 0, skipped: 0 }

  for (const entry of availability) {
    const player = entry.players
    if (!player.email) {
      results.skipped++
      continue
    }

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
    const cancelUrl = `${baseUrl}/cancel/${player.signup_token}/${sessionId}`

    const success = await sendReminder({
      playerName: player.first_name,
      playerEmail: player.email,
      sessionDate,
      startTime: session.start_time,
      location: session.location,
      notes: session.notes,
      cancelUrl
    })

    if (success) {
      results.sent++
    } else {
      results.failed++
    }
  }

  await supabase
    .from('sessions')
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq('id', sessionId)

  return Response.json({ success: true, results })
}