import { supabase } from '@/lib/supabase'
import { sendSignupRequest } from '@/lib/email'

export async function POST(request) {
  const { weekId } = await request.json()

  const { data: week, error: weekError } = await supabase
    .from('weeks')
    .select('*')
    .eq('id', weekId)
    .single()

  if (weekError) {
    return Response.json({ error: 'Week not found' }, { status: 404 })
  }

  const weekLabel = new Date(week.start_date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })

  const { data: players, error: playersError } = await supabase
    .from('players')
    .select('id, first_name, email, signup_token')
    .eq('active', true)
    .not('email', 'is', null)

  if (playersError) {
    return Response.json({ error: 'Error fetching players' }, { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
  const results = { sent: 0, failed: 0, skipped: 0 }

  for (const player of players) {
    if (!player.email || !player.signup_token) {
      results.skipped++
      continue
    }

    const signupUrl = `${baseUrl}/signup/${player.signup_token}`
    const success = await sendSignupRequest({
      playerName: player.first_name,
      playerEmail: player.email,
      signupUrl,
      weekLabel
    })

    if (success) {
      results.sent++
    } else {
      results.failed++
    }
  }

await supabase
    .from('weeks')
    .update({ signup_sent_at: new Date().toISOString() })
    .eq('id', weekId)

  return Response.json({ success: true, results })}