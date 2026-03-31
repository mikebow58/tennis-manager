import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendSignupRequest({ playerName, playerEmail, signupUrl, weekLabel }) {
  const { error } = await resend.emails.send({
    from: 'Treviso Racquet Club <onboarding@resend.dev>',
    to: playerEmail,
    subject: `Sign up for tennis this week — ${weekLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Hi ${playerName},</h2>
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

  if (error) {
    console.error('Email error:', error)
    return false
  }

  return true
}

export async function sendReminder({ playerName, playerEmail, sessionDate, startTime, location, notes, cancelUrl }) {
  const { error } = await resend.emails.send({
    from: 'Treviso Racquet Club <onboarding@resend.dev>',
    to: playerEmail,
    subject: `Tennis reminder — ${sessionDate}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">See you out there, ${playerName}!</h2>
        <p style="color: #444; line-height: 1.6;">
          Just a reminder that you're signed up for tennis on <strong>${sessionDate}</strong>.
        </p>
        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Time</span><br/>
            <span style="color: #111; font-weight: 500;">${startTime}</span>
          </div>
          <div>
            <span style="color: #888; font-size: 13px;">Location</span><br/>
            <span style="color: #111; font-weight: 500;">${location}</span>
          </div>
        </div>
        ${notes ? `<p style="color: #444; font-size: 14px;">${notes}</p>` : ''}
        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee;">
          <a href="${cancelUrl}" style="color: #888; font-size: 12px;">Can't make it? Cancel your spot</a>
        </div>
      </div>
    `
  })

  if (error) {
    console.error('Email error:', error)
    return false
  }

  return true
}

export async function sendCancellationNotice({ adminEmail, playerName, sessionDate, location }) {
  const { error } = await resend.emails.send({
    from: 'Treviso Racquet Club <onboarding@resend.dev>',
    to: adminEmail,
    subject: `Cancellation — ${playerName} · ${sessionDate}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Cancellation notice</h2>
        <p style="color: #444; line-height: 1.6;">
          <strong>${playerName}</strong> has cancelled their spot for 
          <strong>${sessionDate}</strong> at ${location}.
        </p>
        <p style="color: #444; line-height: 1.6;">
          You may need to find a replacement or adjust the lineup.
        </p>
      </div>
    `
  })

  if (error) {
    console.error('Cancellation notice error:', error)
    return false
  }

  return true
}