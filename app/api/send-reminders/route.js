import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { sendEmailBatch } from '@/lib/email'
import { formatTime } from '@/lib/utils'

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

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
  let skipped = 0

  // Build one email object per eligible player — no API calls yet
  const emails = []
  for (const entry of availability) {
    const player = entry.players
    if (!player.email) {
      skipped++
      continue
    }
    const cancelUrl = `${baseUrl}/cancel/${player.signup_token}/${sessionId}`
    emails.push({
      from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
      to: player.email,
      subject: `Tennis reminder — ${sessionDate}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111; margin-bottom: 8px;">See you out there, ${player.first_name}!</h2>
          <p style="color: #444; line-height: 1.6;">
            Just a reminder that you're signed up for tennis on <strong>${sessionDate}</strong>.
          </p>
          <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 24px 0;">
            <div style="margin-bottom: 8px;">
              <span style="color: #888; font-size: 13px;">Time</span><br/>
              <span style="color: #111; font-weight: 500;">${formatTime(session.start_time)}</span>
            </div>
            <div>
              <span style="color: #888; font-size: 13px;">Location</span><br/>
              <span style="color: #111; font-weight: 500;">${session.location}</span>
            </div>
          </div>
          ${session.notes ? `<p style="color: #444; font-size: 14px;">${session.notes}</p>` : ''}
          <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee;">
            <a href="${cancelUrl}" style="color: #888; font-size: 12px;">Can't make it? Cancel your spot</a>
          </div>
        </div>
      `
    })
  }

  // Single batch call
  const { sent, failed } = await sendEmailBatch(emails)

  await supabase
    .from('sessions')
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq('id', sessionId)

  return Response.json({ success: true, results: { sent, failed, skipped } })
}