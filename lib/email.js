// lib/email.js
// Single source of truth for all outbound email in the Tennis Group Manager.
// All sends — player-facing and organiser-facing — must go through this file.
// No email is ever sent from an API route or cron directly.
//
// DEV EMAIL SAFETY:
// If DEV_EMAIL_OVERRIDE is set in the environment, ALL outbound emails
// (both player-facing and organiser-facing) are redirected to that address.
// Set this on the dev branch in Vercel to prevent any email reaching real
// players or the organiser during V2 development and testing.
//
// THIS REVISION (Sept 2026 session — Player page build):
// Added a shared buildFooterHtml() helper and wired an optional
// `playerPageUrl` (pointing at /signup/${token} — the permanent, non-
// rotating "Player page," per organiser decision, state handoff Sept 11
// 2026) into every player-facing send function's footer. No new route was
// built — /signup/[token] itself now does double duty as the year-round
// status/portal destination.
//
// BUG FIX FOUND DURING THIS WORK (separate from the portal-link deferral):
// several player-facing functions receive a `cancelUrl` from their caller
// that was being built as `${baseUrl}/portal/${token}` — not just pointing
// at the deferred (and now permanently-not-built) /portal route, but
// pointing there where a genuine per-session CANCEL action was intended.
// The real cancel route is `/cancel/${token}/${sessionId}` (confirmed
// correct and already in use this way in lib/sub-requests.js). This file
// doesn't construct cancelUrl itself — that happens in each caller — but
// the callers touched this session (daily-8am, daily-8pm-backstop) have
// been fixed accordingly. Any other caller still passing a `/portal/...`
// cancelUrl has the same bug and needs the same fix when next touched.
//
// Renamed `portalUrl` -> `playerPageUrl` on the two functions that already
// had a portal-style footer link (sendSignupRequestBatch,
// sendWaitlistSpotOpenedToConfirmed) for naming consistency with the
// Player page decision. Both callers were available this session and have
// been updated to match.
//
// PRIOR REVISION (Sept 2026 session — contact page security review):
// sendPlayerContactSubmission removed. The contact FORM and its POST
// endpoint (app/api/contact/route.js) were retired: unauthenticated
// free-text submission had no rate limiting (spam vector) and interpolated
// senderName/senderEmail/message directly into the outbound HTML with no
// escaping (HTML/email-injection vector, worst in anonymous mode where
// those fields were fully attacker-controlled). Replaced with a static
// contact-info page — see app/contact/page.js.

import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

// If DEV_EMAIL_OVERRIDE is set, all emails are redirected to this address.
// This covers both single-recipient sends and batch builds.
const DEV_OVERRIDE = process.env.DEV_EMAIL_OVERRIDE || null

/**
 * Resolves the actual recipient address for a single-recipient send.
 * In dev (DEV_EMAIL_OVERRIDE set), returns the override address.
 * In production, returns the intended address unchanged.
 * @param {string} intendedEmail
 * @returns {string}
 */
function resolveRecipient(intendedEmail) {
  if (DEV_OVERRIDE) {
    return DEV_OVERRIDE
  }
  return intendedEmail
}

/**
 * Shared footer builder for player-facing emails. Composes whichever
 * pieces the caller has available — a per-session cancel action link
 * and/or the permanent Player page bookmark link — into one consistent
 * footer block. Returns an empty string if neither is provided, so it's
 * always safe to call even from functions where a caller hasn't been
 * updated to pass playerPageUrl yet.
 *
 * @param {object} params
 * @param {string} [params.cancelUrl] - per-session cancel action link
 * @param {string} [params.playerPageUrl] - permanent /signup/${token} link
 * @returns {string} HTML block, or '' if nothing to render
 */
function buildFooterHtml({ cancelUrl, playerPageUrl } = {}) {
  if (!cancelUrl && !playerPageUrl) return ''

  const cancelHtml = cancelUrl
    ? `<a href="${cancelUrl}" style="color: #888; font-size: 12px;">Can't make it? Cancel your spot</a>`
    : ''

  const playerPageHtml = playerPageUrl
    ? `
      <p style="color: #aaa; font-size: 12px; margin: ${cancelUrl ? '12px' : '0'} 0 0 0;">
        Your personal tennis page — bookmark it for quick access anytime:<br/>
        <a href="${playerPageUrl}" style="color: #2563eb;">${playerPageUrl}</a>
      </p>`
    : ''

  return `
    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee;">
      ${cancelHtml}
      ${playerPageHtml}
    </div>
  `
}

// ---------------------------------------------------------------------------
// EXISTING FUNCTIONS — unchanged from V1 except DEV_OVERRIDE applied and
// (this revision) an optional playerPageUrl footer wired in.
// ---------------------------------------------------------------------------

/**
 * Single personalised signup link email to one player.
 * NOTE: known caller is app/api/players/[id]/resend-signup/route.js (one-off
 * signup resend) — not confirmed passing playerPageUrl yet as of this
 * revision; file wasn't available this session. Safe either way — param is
 * optional and no-ops if omitted.
 */
export async function sendSignupRequest({ playerName, playerEmail, signupUrl, weekLabel, playerPageUrl }) {
  const to = resolveRecipient(playerEmail)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
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
        ${buildFooterHtml({ playerPageUrl })}
      </div>
    `
  })

  if (error) {
    console.error('sendSignupRequest error:', error)
    return false
  }
  return true
}

/**
 * Single reminder email to one player (legacy V1-style; superseded for
 * batch sends by sendConfirmedReminderBatch() / sendTentativeReminderBatch()).
 * playerPageUrl is optional here since this function is believed to have
 * no remaining active callers — added for consistency, not urgency.
 */
export async function sendReminder({ playerName, playerEmail, sessionDate, startTime, location, notes, cancelUrl, playerPageUrl }) {
  const to = resolveRecipient(playerEmail)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
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
        ${buildFooterHtml({ cancelUrl, playerPageUrl })}
      </div>
    `
  })

  if (error) {
    console.error('sendReminder error:', error)
    return false
  }
  return true
}

export async function sendCancellationNotice({ adminEmail, playerName, sessionDate, location }) {
  const rawTo = adminEmail.includes(',')
    ? adminEmail.split(',').map(e => e.trim())
    : adminEmail
  const to = DEV_OVERRIDE ? DEV_OVERRIDE : rawTo

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
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
    console.error('sendCancellationNotice error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — WEEK CREATION NOTIFICATIONS (used by monday_week_creation cron)
// Organiser-facing — no Player page footer needed.
// ---------------------------------------------------------------------------

export async function sendWeekCreatedNotification({ adminEmail, weekId, weekLabel, approvalUrl }) {
  const to = DEV_OVERRIDE ? DEV_OVERRIDE : adminEmail

  console.log(`sendWeekCreatedNotification: sending to ${to} for week ${weekId}`)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `New week ready for approval — ${weekLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">New week created</h2>
        <p style="color: #444; line-height: 1.6;">
          The week of <strong>${weekLabel}</strong> has been automatically created
          from your default sessions. Please review and approve it before Friday's
          signup send.
        </p>
        <div style="margin: 32px 0;">
          <a href="${approvalUrl}"
            style="background: #16a34a; color: white; padding: 12px 24px;
            border-radius: 8px; text-decoration: none; font-weight: 500;">
            Review and approve
          </a>
        </div>
        <p style="color: #888; font-size: 13px;">
          Or copy this link into your browser:<br/>
          <a href="${approvalUrl}" style="color: #2563eb;">${approvalUrl}</a>
        </p>
      </div>
    `
  })

  if (error) {
    console.error('sendWeekCreatedNotification error:', error)
    return false
  }
  return true
}

export async function sendWeekDumpedNotification({ adminEmail, dumpedWeekLabel }) {
  const to = DEV_OVERRIDE ? DEV_OVERRIDE : adminEmail

  console.log(`sendWeekDumpedNotification: sending to ${to} for dumped week ${dumpedWeekLabel}`)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Prior week auto-deleted — ${dumpedWeekLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Prior week was auto-deleted</h2>
        <p style="color: #444; line-height: 1.6;">
          The week of <strong>${dumpedWeekLabel}</strong> was still waiting for approval
          when this week's auto-creation ran. It has been automatically deleted.
        </p>
        <p style="color: #444; line-height: 1.6;">
          A new week has been created for this cycle and is ready for your review.
        </p>
      </div>
    `
  })

  if (error) {
    console.error('sendWeekDumpedNotification error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — APPROVAL REMINDER NOTIFICATIONS (organiser-facing — no change)
// ---------------------------------------------------------------------------

export async function sendApprovalReminderNotification({ adminEmail, weekLabel, approvalUrl }) {
  const to = DEV_OVERRIDE ? DEV_OVERRIDE : adminEmail

  console.log(`sendApprovalReminderNotification: sending to ${to} for week ${weekLabel}`)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Reminder: week of ${weekLabel} needs your approval`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Approval reminder</h2>
        <p style="color: #444; line-height: 1.6;">
          The week of <strong>${weekLabel}</strong> is still waiting for your approval.
          Signup links go out on Friday — please review and approve before then.
        </p>
        <div style="margin: 32px 0;">
          <a href="${approvalUrl}"
            style="background: #16a34a; color: white; padding: 12px 24px;
            border-radius: 8px; text-decoration: none; font-weight: 500;">
            Review and approve
          </a>
        </div>
        <p style="color: #888; font-size: 13px;">
          Or copy this link into your browser:<br/>
          <a href="${approvalUrl}" style="color: #2563eb;">${approvalUrl}</a>
        </p>
      </div>
    `
  })

  if (error) {
    console.error('sendApprovalReminderNotification error:', error)
    return false
  }
  return true
}

export async function sendUrgentApprovalReminderNotification({ adminEmail, weekLabel, approvalUrl }) {
  const to = DEV_OVERRIDE ? DEV_OVERRIDE : adminEmail

  console.log(`sendUrgentApprovalReminderNotification: sending to ${to} for week ${weekLabel}`)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `URGENT: approve the week of ${weekLabel} before tomorrow`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #dc2626; margin-bottom: 8px;">Action required today</h2>
        <p style="color: #444; line-height: 1.6;">
          The week of <strong>${weekLabel}</strong> has not been approved yet.
          Signup links go out tomorrow morning — if the week is not approved by then,
          the automated send will be skipped and players will not receive their signup links.
        </p>
        <div style="margin: 32px 0;">
          <a href="${approvalUrl}"
            style="background: #dc2626; color: white; padding: 12px 24px;
            border-radius: 8px; text-decoration: none; font-weight: 500;">
            Approve now
          </a>
        </div>
        <p style="color: #888; font-size: 13px;">
          Or copy this link into your browser:<br/>
          <a href="${approvalUrl}" style="color: #2563eb;">${approvalUrl}</a>
        </p>
      </div>
    `
  })

  if (error) {
    console.error('sendUrgentApprovalReminderNotification error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// BATCH HELPER — all multi-recipient sends must use this
// ---------------------------------------------------------------------------

async function sendBatchChunk(emails) {
  const { data, error } = await resend.batch.send(emails)

  if (error) {
    console.error('sendBatchChunk error:', error)
    return { sent: 0, failed: emails.length }
  }

  const sentCount = Array.isArray(data) ? data.length : (data?.data?.length ?? emails.length)
  return { sent: sentCount, failed: emails.length - sentCount }
}

export async function sendEmailBatch(emails) {
  const CHUNK_SIZE = 100

  const resolvedEmails = DEV_OVERRIDE
    ? emails.map(e => ({ ...e, to: DEV_OVERRIDE }))
    : emails

  const results = { sent: 0, failed: 0 }

  for (let i = 0; i < resolvedEmails.length; i += CHUNK_SIZE) {
    const chunk = resolvedEmails.slice(i, i + CHUNK_SIZE)
    const { sent, failed } = await sendBatchChunk(chunk)
    results.sent += sent
    results.failed += failed
  }

  return results
}

/**
 * THIS REVISION: `portalUrl` renamed to `playerPageUrl` on the per-player
 * payload shape, for naming consistency with the Player page decision.
 * Both known callers (friday-signup-send cron, and the refactored
 * /api/send-signup-requests route) updated to match this session.
 */
export async function sendSignupRequestBatch(players, weekLabel) {
  const devOverride = process.env.DEV_EMAIL_OVERRIDE || null

  const emails = players.map((player) => ({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: devOverride || player.playerEmail,
    subject: `Sign up for tennis this week — ${weekLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Hi ${player.playerFirstName},</h2>
        <p style="color: #444; line-height: 1.6;">
          It's time to sign up for tennis this week (${weekLabel}). Tap the button
          below to choose the days you want to play.
        </p>

        <div style="margin: 32px 0;">
          <a href="${player.signupUrl}"
             style="background: #16a34a; color: white; padding: 12px 24px;
                    border-radius: 8px; text-decoration: none; font-weight: 500;">
            Sign up for this week
          </a>
        </div>

        <p style="color: #888; font-size: 13px;">
          Or copy this link into your browser:<br/>
          <a href="${player.signupUrl}" style="color: #2563eb;">${player.signupUrl}</a>
        </p>

        ${buildFooterHtml({ playerPageUrl: player.playerPageUrl })}
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

export async function sendSignupSkippedNotification({ adminEmail, weekLabel, weekId }) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  const approvalUrl = `${baseUrl}/admin/weeks/${weekId}/approve`

  const devOverride = process.env.DEV_EMAIL_OVERRIDE || null

  const resolvedTo = devOverride
    ? devOverride
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: resolvedTo,
    subject: `Signup send skipped — week of ${weekLabel} still needs approval`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Signup send skipped</h2>

        <p style="color: #444; line-height: 1.6;">
          The automated signup send for the week of <strong>${weekLabel}</strong>
          was skipped because the week hasn't been approved yet.
          <strong>Players have not been notified.</strong>
        </p>

        <p style="color: #444; line-height: 1.6;">
          To approve the week and send signup links now:
        </p>

        <div style="margin: 32px 0;">
          <a href="${approvalUrl}"
             style="background: #dc2626; color: white; padding: 12px 24px;
                    border-radius: 8px; text-decoration: none; font-weight: 500;">
            Approve and send now
          </a>
        </div>

        <p style="color: #888; font-size: 13px;">
          Or copy this link into your browser:<br/>
          <a href="${approvalUrl}" style="color: #2563eb;">${approvalUrl}</a>
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('Signup skipped notification error:', error)
    return false
  }

  return true
}

export async function sendWeekApprovedNotification({ adminEmail, weekLabel, weekId }) {
  const recipient = DEV_OVERRIDE || (adminEmail.includes(',')
    ? adminEmail.split(',').map((e) => e.trim())
    : adminEmail)

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendWeekApprovedNotification redirected to ${DEV_OVERRIDE}`)
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://gtcourts.com'
  const approveUrl = `${baseUrl}/admin/weeks/${weekId}/approve`

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: recipient,
    subject: `Week approved — ${weekLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Week approved</h2>
        <p style="color: #444; line-height: 1.6;">
          The week of <strong>${weekLabel}</strong> has been approved.
          Signup links will be sent automatically on Friday morning.
        </p>
        <p style="color: #444; line-height: 1.6;">
          You can still edit sessions or send signup links early from the approval page.
        </p>
        <div style="margin: 32px 0;">
          <a href="${approveUrl}"
             style="background: #16a34a; color: white; padding: 12px 24px;
                    border-radius: 8px; text-decoration: none; font-weight: 500;">
            View week
          </a>
        </div>
        <p style="color: #888; font-size: 13px;">
          Or copy this link:<br/>
          <a href="${approveUrl}" style="color: #2563eb;">${approveUrl}</a>
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendWeekApprovedNotification error:', error)
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// V2 — REMINDER EMAILS (used by daily_8am cron, Check B)
// THIS REVISION: each player payload now carries a playerPageUrl field
// (set by daily-8am to /signup/${token}) in addition to cancelUrl (fixed
// this session to point at /cancel/${token}/${sessionId} — see file header
// bug note).
// ---------------------------------------------------------------------------

export async function sendConfirmedReminderBatch(players) {
  const emails = players.map((player) => {
    const rosterHtml = Array.isArray(player.rosterNames) && player.rosterNames.length > 0
      ? `
        <div style="margin: 16px 0;">
          <span style="color: #888; font-size: 13px; display: block; margin-bottom: 6px;">
            Who's playing
          </span>
          <span style="color: #111; font-size: 14px; line-height: 1.6;">
            ${player.rosterNames.join(', ')}
          </span>
        </div>
      `
      : ''

    return {
      from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
      to: player.playerEmail,
      subject: `Tennis reminder — ${player.sessionDate}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111; margin-bottom: 8px;">See you out there, ${player.playerFirstName}!</h2>
          <p style="color: #444; line-height: 1.6;">
            You're confirmed for tennis on <strong>${player.sessionDate}</strong>.
          </p>
          <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 24px 0;">
            <div style="margin-bottom: 8px;">
              <span style="color: #888; font-size: 13px;">Time</span><br/>
              <span style="color: #111; font-weight: 500;">${player.startTime}</span>
            </div>
            <div>
              <span style="color: #888; font-size: 13px;">Location</span><br/>
              <span style="color: #111; font-weight: 500;">${player.locationName}</span>
            </div>
          </div>
          ${rosterHtml}
          ${player.notes ? `<p style="color: #444; font-size: 14px;">${player.notes}</p>` : ''}
          ${buildFooterHtml({ cancelUrl: player.cancelUrl, playerPageUrl: player.playerPageUrl })}
        </div>
      `,
    }
  })

  return sendEmailBatch(emails)
}

export async function sendTentativeReminderBatch(players) {
  const emails = players.map((player) => ({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: player.playerEmail,
    subject: `Tennis update — ${player.sessionDate}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Hi ${player.playerFirstName},</h2>
        <p style="color: #444; line-height: 1.6;">
          You're tentatively on the roster for tennis on
          <strong>${player.sessionDate}</strong>.
        </p>
        <p style="color: #444; line-height: 1.6;">
          We still need to find one or more players to complete your court.
          We're working on it now and will let you know one way or the other
          by <strong>8:00pm ${player.deadlineLabel}</strong>.
        </p>
        <p style="color: #444; line-height: 1.6;">
          If we can't fill the court, we'll notify you promptly so you can
          make other plans.
        </p>
        ${buildFooterHtml({ cancelUrl: player.cancelUrl, playerPageUrl: player.playerPageUrl })}
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

// ---------------------------------------------------------------------------
// V2 — POST-CLOSE CANCELLATION ALERT (organiser-facing — no change)
// ---------------------------------------------------------------------------

export async function sendPostCloseCancellationAlert({
  adminEmail,
  cancelledPlayerName,
  cancelledPlayerStatus,
  sessionDateLabel,
  locationName,
  confirmedCount,
  capacity,
  subsNeeded,
  systemAction,
  promotionSummary = null,
  confirmedPlayerNames = [],
  tentativePlayerNames = [],
  deadlineLabel = '8:00pm',
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendPostCloseCancellationAlert redirected to ${DEV_OVERRIDE}`)
  }

  const statusLabel = cancelledPlayerStatus === 'confirmed' ? 'confirmed' : 'tentative'
  const spotLabel = subsNeeded === 1
    ? '1 sub needed'
    : subsNeeded === 0
      ? 'no subs needed'
      : `${subsNeeded} subs needed`

  let contextHtml = ''

  if (cancelledPlayerStatus === 'tentative') {
    const tentativeListText = tentativePlayerNames.length > 0
      ? tentativePlayerNames.join(', ')
      : 'none'
    const tentativeCount = tentativePlayerNames.length
    const subsText = subsNeeded === 1 ? '1 sub' : `${subsNeeded} subs`
    const courtText = tentativeCount === 1
      ? `There is 1 remaining tentative player (${tentativeListText}).`
      : tentativeCount > 1
        ? `There are ${tentativeCount} remaining tentative players (${tentativeListText}).`
        : `There are no remaining tentative players.`

    contextHtml = `
      <p style="color: #444; line-height: 1.6;">
        <strong>${cancelledPlayerName}</strong> was tentatively on the roster prior to
        cancelling — the system was seeking a sub to fill out their court.
        ${courtText}
        The system is seeking ${subsText} to complete the court.
      </p>
    `
  } else if (cancelledPlayerStatus === 'confirmed' && promotionSummary) {
    const tentativeListText = tentativePlayerNames.length > 0
      ? tentativePlayerNames.join(', ')
      : 'none'
    const tentativeCount = tentativePlayerNames.length
    const subsText = subsNeeded === 1 ? '1 sub' : `${subsNeeded} subs`
    const remainingTentativeText = tentativeCount === 1
      ? `There is 1 remaining tentative player (${tentativeListText}).`
      : tentativeCount > 1
        ? `There are ${tentativeCount} remaining tentative players (${tentativeListText}).`
        : ''

    contextHtml = `
      <p style="color: #444; line-height: 1.6;">
        <strong>${cancelledPlayerName}</strong> cancelled their confirmed spot.
        ${promotionSummary}
        ${remainingTentativeText}
        ${subsNeeded > 0 ? `The system is seeking ${subsText} to complete the court.` : ''}
      </p>
    `
  } else if (cancelledPlayerStatus === 'confirmed' && subsNeeded > 0) {
    const subsText = subsNeeded === 1 ? '1 sub' : `${subsNeeded} subs`
    contextHtml = `
      <p style="color: #444; line-height: 1.6;">
        <strong>${cancelledPlayerName}</strong> cancelled their confirmed spot.
        The system is seeking ${subsText} to complete the court.
      </p>
    `
  } else if (subsNeeded === 0) {
    contextHtml = `
      <p style="color: #444; line-height: 1.6;">
        <strong>${cancelledPlayerName}</strong> cancelled, but the remaining players
        fill the courts perfectly. No replacement is needed.
      </p>
    `
  }

  const confirmedListHtml = confirmedPlayerNames.length > 0
    ? `
      <div style="margin-bottom: 12px;">
        <span style="color: #888; font-size: 13px;">Confirmed players (${confirmedPlayerNames.length})</span><br/>
        <span style="color: #111;">${confirmedPlayerNames.join(', ')}</span>
      </div>
    `
    : `
      <div style="margin-bottom: 12px;">
        <span style="color: #888; font-size: 13px;">Confirmed players</span><br/>
        <span style="color: #111;">None</span>
      </div>
    `

  const deadlineWarningHtml = subsNeeded > 0 && tentativePlayerNames.length > 0
    ? `
      <p style="color: #444; line-height: 1.6; font-size: 14px;">
        If the court cannot be filled by ${deadlineLabel},
        <strong>${tentativePlayerNames.join(', ')}</strong>
        will be notified that ${tentativePlayerNames.length === 1 ? 'they have been' : 'they have been'}
        removed from the ${sessionDateLabel} roster.
      </p>
    `
    : ''

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Cancellation — ${cancelledPlayerName} (${statusLabel}) · ${sessionDateLabel} · ${spotLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Cancellation — ${sessionDateLabel}</h2>

        ${contextHtml}

        ${promotionSummary && cancelledPlayerStatus === 'confirmed' ? `
        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="color: #166534; margin: 0; font-size: 14px;">
            ${promotionSummary}
          </p>
        </div>` : ''}

        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
          ${confirmedListHtml}
        </div>

        ${deadlineWarningHtml}
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendPostCloseCancellationAlert error:', error)
    return false
  }
  return true
}

/**
 * THIS REVISION: added optional playerPageUrl param, rendered via the
 * shared footer helper alongside the existing cancelUrl. cancelUrl was
 * already correct at both known call sites in lib/sub-requests.js
 * (/cancel/${token}/${sessionId}) — no bug here, just adding the new link.
 */
export async function sendTentativePromotedToConfirmed({
  playerFirstName,
  playerEmail,
  sessionDateLabel,
  locationName,
  startTime,
  cancelUrl,
  playerPageUrl,
}) {
  const to = DEV_OVERRIDE ?? playerEmail

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendTentativePromotedToConfirmed redirected to ${DEV_OVERRIDE}`)
  }

  const startTimeLabel = startTime
    ? new Date(`1970-01-01T${startTime}Z`).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
      })
    : 'TBD'

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `You're confirmed — ${sessionDateLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Good news — you're confirmed!</h2>

        <p style="color: #444; line-height: 1.6;">
          Hi ${playerFirstName}, a spot has opened up and you've been moved from
          the tentative list to the confirmed roster for
          <strong>${sessionDateLabel}</strong>.
        </p>

        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Date</span><br/>
            <span style="color: #111; font-weight: 500;">${sessionDateLabel}</span>
          </div>
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Time</span><br/>
            <span style="color: #111; font-weight: 500;">${startTimeLabel}</span>
          </div>
          <div>
            <span style="color: #888; font-size: 13px;">Location</span><br/>
            <span style="color: #111; font-weight: 500;">${locationName}</span>
          </div>
        </div>

        <p style="color: #444; line-height: 1.6;">
          Court assignment details will be sent by 8:00pm the evening before the session.
        </p>

        ${buildFooterHtml({ cancelUrl, playerPageUrl })}
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendTentativePromotedToConfirmed error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — ESCALATION NOTICE (organiser-facing — no change)
// ---------------------------------------------------------------------------

export async function sendEscalationNotice({
  adminEmail,
  sessionDateLabel,
  locationName,
  startTime,
  confirmedCount,
  tentativeCount,
  subsNeeded,
  lastCancelledAt,
  subRequestStatus,
  deadlineLabel,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendEscalationNotice redirected to ${DEV_OVERRIDE}`)
  }

  let timeSinceCancelHtml = ''
  if (lastCancelledAt) {
    const msSinceCancel = Date.now() - new Date(lastCancelledAt).getTime()
    const hoursSince = Math.floor(msSinceCancel / (1000 * 60 * 60))
    const minsSince = Math.floor((msSinceCancel % (1000 * 60 * 60)) / (1000 * 60))
    const timeSinceLabel = hoursSince > 0
      ? `${hoursSince}h ${minsSince}m ago`
      : `${minsSince}m ago`
    timeSinceCancelHtml = `
      <div style="margin-bottom: 8px;">
        <span style="color: #888; font-size: 13px;">Last cancellation</span><br/>
        <span style="color: #111; font-weight: 500;">${timeSinceLabel}</span>
      </div>
    `
  }

  let subRequestHtml = ''
  if (subRequestStatus === 'active') {
    subRequestHtml = `
      <div style="margin-bottom: 8px;">
        <span style="color: #888; font-size: 13px;">Sub request</span><br/>
        <span style="color: #111; font-weight: 500;">Active — broadcast sent, awaiting responses</span>
      </div>
    `
  } else if (subRequestStatus === 'closed') {
    subRequestHtml = `
      <div style="margin-bottom: 8px;">
        <span style="color: #888; font-size: 13px;">Sub request</span><br/>
        <span style="color: #111; font-weight: 500;">Closed — no active broadcast</span>
      </div>
    `
  } else {
    subRequestHtml = `
      <div style="margin-bottom: 8px;">
        <span style="color: #888; font-size: 13px;">Sub request</span><br/>
        <span style="color: #111; font-weight: 500;">None sent</span>
      </div>
    `
  }

  const subsLabel = subsNeeded === 1 ? '1 player needed' : `${subsNeeded} players needed`

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Escalation — ${sessionDateLabel} still short · ${subsLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #b45309; margin-bottom: 8px;">Session still short — ${sessionDateLabel}</h2>

        <p style="color: #444; line-height: 1.6;">
          It's 5:00pm and <strong>${sessionDateLabel}</strong> is still short.
          The automated broadcast window closes at 6:00pm.
          Consider beginning manual outreach now.
        </p>

        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Session</span><br/>
            <span style="color: #111; font-weight: 500;">${sessionDateLabel} · ${startTime} · ${locationName}</span>
          </div>
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Roster</span><br/>
            <span style="color: #111; font-weight: 500;">${confirmedCount} confirmed · ${tentativeCount} tentative · ${subsLabel}</span>
          </div>
          ${timeSinceCancelHtml}
          ${subRequestHtml}
        </div>

        <p style="color: #444; line-height: 1.6; font-size: 14px;">
          If the session is still short at ${deadlineLabel}, the incomplete court
          will be auto-cancelled and affected players notified immediately.
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendEscalationNotice error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — COURT ASSIGNMENT REVIEW (organiser-facing — no change)
// ---------------------------------------------------------------------------

export async function sendCourtAssignmentReview({
  adminEmail,
  sessionDateLabel,
  locationName,
  startTime,
  confirmedCount,
  tentativeCount,
  subsNeeded,
  deadlineLabel,
  tentativePlayerNames,
  courtSummaryLines = [],
  reviewUrl,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendCourtAssignmentReview redirected to ${DEV_OVERRIDE}`)
  }

  const isShortSession = tentativeCount > 0 || subsNeeded > 0

  const subsLabel = subsNeeded === 1 ? '1 player still needed' : `${subsNeeded} players still needed`

  const addPlayersPhrase = subsNeeded === 1 ? 'a player' : `${subsNeeded} players`

  const subject = isShortSession
    ? `Court assignment — ${sessionDateLabel} · ${subsLabel} · action by ${deadlineLabel}`
    : `Court assignment ready — ${sessionDateLabel} · All courts full`

  const bodyParagraph = isShortSession
    ? `<strong>${sessionDateLabel}</strong> is still short at 6:00pm. 
       The automated broadcast window is now closed. 
       You have until <strong>${deadlineLabel}</strong> to add ${addPlayersPhrase} manually 
       before the incomplete court is auto-cancelled.`
    : `<strong>${sessionDateLabel}</strong> is fully arranged and balanced! 
       All confirmed players have been assigned to complete courts. 
       Please review the arrangements below before approving and notifying the players.`

  const atRiskHtml = isShortSession && tentativePlayerNames.length > 0
    ? `
      <p style="color: #444; line-height: 1.6; font-size: 14px;">
        If the court cannot be filled by ${deadlineLabel},
        <strong>${tentativePlayerNames.join(', ')}</strong>
        will be notified that ${tentativePlayerNames.length === 1 ? 'their spot has been cancelled' : 'their spots have been cancelled'}.
      </p>
    `
    : ''

  const warningBannerHtml = isShortSession
    ? `
      <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="color: #991b1b; font-size: 14px; margin: 0;">
          <strong>Auto-cancel at ${deadlineLabel}:</strong> If you have not manually added ${addPlayersPhrase}
          by ${deadlineLabel}, the system will automatically cancel the incomplete court and
          notify affected players immediately.
        </p>
      </div>
    `
    : ''

  const courtSummaryHtml = courtSummaryLines.length > 0
    ? `
      <div style="margin: 16px 0;">
        <span style="color: #888; font-size: 13px; display: block; margin-bottom: 8px;">
          Recommended court arrangements
        </span>
        ${courtSummaryLines.map((line) => `
          <div style="padding: 8px 12px; background: #f9fafb; border-radius: 6px; margin-bottom: 6px; font-size: 14px; color: #111;">
            ${line}
          </div>
        `).join('')}
      </div>
    `
    : ''

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Court assignment — ${sessionDateLabel}</h2>

        <p style="color: #444; line-height: 1.6;">
          ${bodyParagraph}
        </p>

        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Session</span><br/>
            <span style="color: #111; font-weight: 500;">${sessionDateLabel} · ${startTime} · ${locationName}</span>
          </div>
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Roster</span><br/>
            <span style="color: #111; font-weight: 500;">${confirmedCount} confirmed · ${tentativeCount} tentative · ${isShortSession ? subsLabel : '0 players still needed'}</span>
          </div>
        </div>

        ${courtSummaryHtml}

        <div style="margin: 24px 0;">
  <a href="${reviewUrl}"
     style="background: #1e3a5f; color: white; padding: 12px 24px;
            border-radius: 8px; text-decoration: none; font-weight: 500;
            display: inline-block;">
    Review and approve
  </a>
</div>

        ${atRiskHtml}

        ${warningBannerHtml}
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendCourtAssignmentReview error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — COURT ASSIGNMENT DETAILS (used by daily_8pm_backstop cron)
// THIS REVISION: playerPageUrl added; cancelUrl fixed at the caller (was
// pointing at /portal/${token} — see file header bug note) to
// /cancel/${token}/${sessionId}.
// ---------------------------------------------------------------------------

export async function sendCourtAssignmentDetails(players) {
  const emails = players.map((player) => ({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: player.playerEmail,
    subject: `You're confirmed — ${player.sessionDate}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">You're confirmed — ${player.sessionDate}</h2>

        <p style="color: #444; line-height: 1.6;">
          Hi ${player.playerFirstName}, here are your session details for tomorrow.
        </p>

        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Date</span><br/>
            <span style="color: #111; font-weight: 500;">${player.sessionDate}</span>
          </div>
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Time</span><br/>
            <span style="color: #111; font-weight: 500;">${player.startTime}</span>
          </div>
          <div>
            <span style="color: #888; font-size: 13px;">Location</span><br/>
            <span style="color: #111; font-weight: 500;">${player.locationName}</span>
          </div>
        </div>

        ${player.notes ? `<p style="color: #444; font-size: 14px;">${player.notes}</p>` : ''}

        ${buildFooterHtml({ cancelUrl: player.cancelUrl, playerPageUrl: player.playerPageUrl })}
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

/**
 * THIS REVISION: added optional playerPageUrl per player. No cancelUrl
 * bug here — this email means the session already didn't fill and the
 * player is out; a cancel action wouldn't make sense. playerPageUrl gives
 * them something useful to check for the next open week.
 */
export async function sendCourtCancellationNotice(players) {
  const emails = players.map((player) => ({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: player.playerEmail,
    subject: `You are not playing ${player.sessionDate}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">You are not playing ${player.sessionDate}</h2>

        <p style="color: #444; line-height: 1.6;">
          Hi ${player.playerFirstName}, unfortunately we were not able to find enough
          players to complete your court for <strong>${player.sessionDate}</strong>.
          Enjoy the day off and we'll look forward to seeing you next time.
        </p>

        ${buildFooterHtml({ playerPageUrl: player.playerPageUrl })}
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

export async function sendBackstopCancellationAlert({
  adminEmail,
  sessionDateLabel,
  locationName,
  cancelledCourtPlayerCount,
  confirmedCount,
  cancelledPlayerNames,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendBackstopCancellationAlert redirected to ${DEV_OVERRIDE}`)
  }

  const droppedLabel = cancelledCourtPlayerCount === 1
    ? '1 player was not able to play'
    : `${cancelledCourtPlayerCount} players were not able to play`

  const confirmedLabel = confirmedCount === 1 ? '1 player' : `${confirmedCount} players`

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `8pm auto-cancel — ${sessionDateLabel} · ${droppedLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">8pm backstop — ${sessionDateLabel}</h2>

        <p style="color: #444; line-height: 1.6;">
          The incomplete court for <strong>${sessionDateLabel}</strong> at ${locationName}
          could not be filled in time. The following
          ${cancelledCourtPlayerCount === 1 ? 'player has' : 'players have'}
          been notified that they are not playing and are not expected to attend:
        </p>

        <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <span style="color: #991b1b; font-weight: 500;">${cancelledPlayerNames.join(', ')}</span>
        </div>

        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <div>
            <span style="color: #888; font-size: 13px;">Remaining confirmed players</span><br/>
            <span style="color: #111; font-weight: 500;">${confirmedLabel}</span>
          </div>
        </div>

        <p style="color: #444; line-height: 1.6; font-size: 14px;">
          The ${confirmedLabel} on complete courts have been sent session details
          (time and location).
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendBackstopCancellationAlert error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — COURT ASSIGNMENT DETAILS WITH COURT NUMBER
// (used by approval route and daily_8pm_backstop when court numbers are set)
// THIS REVISION: playerPageUrl added; cancelUrl fixed at the caller (was
// /portal/${token} — see file header bug note).
// ---------------------------------------------------------------------------

export async function sendCourtAssignmentDetailsFull(players) {
  const emails = players.map((player) => ({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: player.playerEmail,
    subject: `Court assignment — ${player.sessionDate}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">You're on Court ${player.courtNumber}</h2>

        <p style="color: #444; line-height: 1.6;">
          Hi ${player.playerFirstName}, here are your details for tomorrow.
        </p>

        <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Date</span><br/>
            <span style="color: #111; font-weight: 500;">${player.sessionDate}</span>
          </div>
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Time</span><br/>
            <span style="color: #111; font-weight: 500;">${player.startTime}</span>
          </div>
          <div style="margin-bottom: 8px;">
            <span style="color: #888; font-size: 13px;">Location</span><br/>
            <span style="color: #111; font-weight: 500;">${player.locationName}</span>
          </div>
          <div>
            <span style="color: #888; font-size: 13px;">Court</span><br/>
            <span style="color: #111; font-weight: 500; font-size: 18px;">Court ${player.courtNumber}</span>
          </div>
        </div>

        ${player.rotationLabel ? `
        <p style="color: #444; font-size: 14px; line-height: 1.6;">
          ${player.rotationLabel}
        </p>` : ''}

        ${player.courtNote ? `
        <div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
          <p style="color: #92400e; font-size: 14px; margin: 0;">
            Note: ${player.courtNote}
          </p>
        </div>` : ''}

        ${player.notes ? `<p style="color: #444; font-size: 14px;">${player.notes}</p>` : ''}

        ${buildFooterHtml({ cancelUrl: player.cancelUrl, playerPageUrl: player.playerPageUrl })}
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

// ---------------------------------------------------------------------------
// V2 — PRE-CLOSE WAITLIST PROMOTION (used by lib/waitlist-promotion.js)
// THIS REVISION: param renamed portalUrl -> playerPageUrl (caller updated
// to match this session); footer now uses the shared, standardized copy.
// ---------------------------------------------------------------------------

export async function sendWaitlistSpotOpenedToConfirmed({
  playerFirstName,
  playerEmail,
  sessionDateLabel,
  locationName,
  playerPageUrl,
}) {
  const to = resolveRecipient(playerEmail)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Good news — you're in! ${sessionDateLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Good news, ${playerFirstName}!</h2>
        <p style="color: #444; line-height: 1.6;">
          A spot opened up for <strong>${sessionDateLabel}</strong> at ${locationName},
          and you've been moved from the waitlist to the confirmed roster.
        </p>
        <p style="color: #444; line-height: 1.6;">
          You're all set — no action needed. We'll see you there!
        </p>
        ${buildFooterHtml({ playerPageUrl })}
      </div>
    `
  })

  if (error) {
    console.error('[email] sendWaitlistSpotOpenedToConfirmed error:', error)
    return false
  }
  return true
}

export async function sendWaitlistPromotionNotice({
  adminEmail,
  cancelledPlayerName,
  promotedPlayerName,
  sessionDateLabel,
  locationName,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Waitlist promotion — ${sessionDateLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Automatic waitlist promotion</h2>
        <p style="color: #444; line-height: 1.6;">
          <strong>${cancelledPlayerName}</strong> cancelled their spot for
          <strong>${sessionDateLabel}</strong> at ${locationName}.
        </p>
        <p style="color: #444; line-height: 1.6;">
          <strong>${promotedPlayerName}</strong> was automatically promoted from
          the waitlist to fill the open spot. The session remains full — no
          action needed on your part.
        </p>
      </div>
    `
  })

  if (error) {
    console.error('[email] sendWaitlistPromotionNotice error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — LATE-ARRIVAL WAITLIST NOTICE (used by app/api/subs/respond/route.js,
// SUCCESS_WAITLISTED path only)
// THIS REVISION: added optional playerPageUrl param. Caller not available
// this session — needs updating to pass it once pasted (safe either way,
// param no-ops if omitted).
// ---------------------------------------------------------------------------

export async function sendAddedToWaitlistNotice({
  playerFirstName,
  playerEmail,
  sessionDateLabel,
  locationName,
  playerPageUrl,
}) {
  const to = resolveRecipient(playerEmail)

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `You're on the waitlist — ${sessionDateLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Thanks, ${playerFirstName}!</h2>
        <p style="color: #444; line-height: 1.6;">
          You're on the waitlist for <strong>${sessionDateLabel}</strong> at ${locationName}.
          We'll reach out right away if a spot opens up.
        </p>
        <p style="color: #444; line-height: 1.6;">
          No action needed for now — just keep an eye on your email.
        </p>
        ${buildFooterHtml({ playerPageUrl })}
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendAddedToWaitlistNotice error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — ADMIN ADD RACE ALERT (organiser-facing — no change)
// ---------------------------------------------------------------------------

export async function sendAdminAddRaceAlert({
  adminEmail,
  addedPlayerName,
  sessionDateLabel,
  locationName,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Heads up — ${addedPlayerName} went to waitlist, not the roster`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Added to waitlist, not the roster</h2>
        <p style="color: #444; line-height: 1.6;">
          You added <strong>${addedPlayerName}</strong> to
          <strong>${sessionDateLabel}</strong> at ${locationName}, but the open spot
          had already been filled by the time the add went through.
        </p>
        <p style="color: #444; line-height: 1.6;">
          ${addedPlayerName} has been placed at the bottom of the waitlist instead.
          You'll want to contact them directly to explain the situation.
        </p>
      </div>
    `
  })

  if (error) {
    console.error('[email] sendAdminAddRaceAlert error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — SUB REQUEST BROADCAST (real player-facing send — used by
// lib/sub-requests.js)
// THIS REVISION: playerPageUrl is built inline here from each recipient's
// signupToken (already present, since it's used to build respondUrl) —
// no caller changes needed for this one.
// ---------------------------------------------------------------------------

export async function sendSubRequestBroadcast(recipients, {
  sessionDateLabel,
  locationName,
  deadlineLabel,
  subRequestId,
}) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

  const emails = recipients.map((player) => {
    const respondUrl =
      `${baseUrl}/subs/respond?token=${encodeURIComponent(player.signupToken)}&sub_id=${subRequestId}`
    const playerPageUrl = player.signupToken
      ? `${baseUrl}/signup/${player.signupToken}`
      : undefined

    return {
      from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
      to: player.email,
      subject: `Open spot — ${sessionDateLabel} at ${locationName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111; margin-bottom: 8px;">Hi ${player.firstName},</h2>
          <p style="color: #444; line-height: 1.6;">
            A spot has opened up for <strong>${sessionDateLabel}</strong> at ${locationName}.
            Want it?
          </p>
          <div style="margin: 32px 0;">
            <a href="${respondUrl}"
               style="background: #16a34a; color: white; padding: 12px 24px;
                      border-radius: 8px; text-decoration: none; font-weight: 500;">
              Respond now
            </a>
          </div>
          <p style="color: #888; font-size: 13px;">
            Or copy this link into your browser:<br/>
            <a href="${respondUrl}" style="color: #2563eb;">${respondUrl}</a>
          </p>
          <p style="color: #444; font-size: 14px; margin-top: 24px;">
            Please respond by <strong>${deadlineLabel}</strong> — after that, this
            request closes and the spot may go to someone else.
          </p>
          ${buildFooterHtml({ playerPageUrl })}
        </div>
      `,
    }
  })

  return sendEmailBatch(emails)
}

// ---------------------------------------------------------------------------
// V2 — SUB REQUEST RESOLVED NOTICE (organiser-facing — no change)
// ---------------------------------------------------------------------------

export async function sendSubRequestResolvedNotice({
  adminEmail,
  sessionDateLabel,
  locationName,
  filledByPlayerName,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Court filled — ${sessionDateLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Court filled — ${sessionDateLabel}</h2>
        <p style="color: #444; line-height: 1.6;">
          <strong>${filledByPlayerName}</strong> confirmed the last open spot for
          <strong>${sessionDateLabel}</strong> at ${locationName}. The court is now
          complete — no further action needed.
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendSubRequestResolvedNotice error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — ORGANISER-ADDED PLAYER REMOVAL ALERT (organiser-facing — no change)
// ---------------------------------------------------------------------------

export async function sendOrganiserAddedPlayerRemovedAlert({
  adminEmail,
  playerName,
  sessionDateLabel,
  locationName,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendOrganiserAddedPlayerRemovedAlert redirected to ${DEV_OVERRIDE}`)
  }

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `${playerName} removed themselves — ${sessionDateLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">A player you added has backed out</h2>
        <p style="color: #444; line-height: 1.6;">
          <strong>${playerName}</strong> has removed themselves from
          <strong>${sessionDateLabel}</strong> at ${locationName}. You had personally
          added this player to the session, so we wanted to flag it directly rather
          than let it pass as routine roster churn.
        </p>
        <p style="color: #444; line-height: 1.6;">
          The session is still open for signups, so no other action has been taken
          automatically — this is just a heads-up in case you want to follow up with
          them or recruit a replacement.
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendOrganiserAddedPlayerRemovedAlert error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// V2 — SESSION CANCELLATION NOTICE (used by
// app/api/sessions/[sessionId]/cancel/route.js)
// THIS REVISION: added optional playerPageUrl per player. Caller not
// available this session — needs updating to add signup_token to its
// player select and pass playerPageUrl once pasted (safe either way, param
// no-ops if omitted).
// ---------------------------------------------------------------------------

export async function sendSessionCancellationNotice(players) {
  const emails = players.map((player) => ({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to: player.playerEmail,
    subject: `Session cancelled — ${player.sessionDateLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Your session has been cancelled</h2>

        <p style="color: #444; line-height: 1.6;">
          Hi ${player.playerFirstName}, unfortunately your tennis session on
          <strong>${player.sessionDateLabel}</strong> at ${player.locationName} has been cancelled.
        </p>

        ${player.cancellationNote ? `
        <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="color: #991b1b; font-size: 14px; margin: 0;">
            <strong>Reason:</strong> ${player.cancellationNote}
          </p>
        </div>` : ''}

        <p style="color: #444; line-height: 1.6;">
          We're sorry for any inconvenience — we'll see you at the next session.
        </p>

        ${buildFooterHtml({ playerPageUrl: player.playerPageUrl })}
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}