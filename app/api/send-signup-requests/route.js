import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { sendEmailBatch } from '@/lib/email'

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

  const weekLabel = new Date(week.week_start_date).toLocaleDateString('en-US', {
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
  let skipped = 0

  // Build one email object per eligible player — no API calls yet
  const emails = []
  for (const player of players) {
    if (!player.email || !player.signup_token) {
      skipped++
      continue
    }
    const signupUrl = `${baseUrl}/signup/${player.signup_token}`
    emails.push({
      from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
      to: player.email,
      subject: `Sign up for tennis this week — ${weekLabel}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111; margin-bottom: 8px;">Hi ${player.first_name},</h2>
          <p style="color: #444; line-height: 1.6;">
            It's time to sign up for tennis this week. Tap the button below to select 
            the days you want to play.
          </p>
          <div style="margin: 32px 0;">
            <a href="${signupUrl}" 
               style="background: #16a34a; color: white; padding: 12px 24px; 
                      border-radius: 8px; text-decoration: none; font-weight: 500;">
              Sign up for this week
            </a>
          </div>
          <p style="color: #888; font-size: 13px;">
            Or copy this link into your browser:<br/>
            <a href="${signupUrl}" style="color: #2563eb;">${signupUrl}</a>
          </p>
        </div>
      `
    })
  }

  // Single batch call (or two calls at 150 players — well within rate limits)
  const { sent, failed } = await sendEmailBatch(emails)

 await supabase
    .from('weeks')
    .update({ 
      status: 'sent',
      signup_sent_at: new Date().toISOString() 
    })
    .eq('id', weekId)

  return Response.json({ success: true, results: { sent, failed, skipped } })
}