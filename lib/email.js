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

// ---------------------------------------------------------------------------
// EXISTING FUNCTIONS — unchanged from V1 except DEV_OVERRIDE applied
// ---------------------------------------------------------------------------

/**
 * Sends a personalised signup link to a single player.
 * Used for one-off resends from the admin player page.
 * Multi-recipient signup sends must use sendEmailBatch() instead.
 *
 * @param {object} params
 * @param {string} params.playerName
 * @param {string} params.playerEmail
 * @param {string} params.signupUrl   - Absolute URL including NEXT_PUBLIC_BASE_URL
 * @param {string} params.weekLabel   - e.g. "May 12 – May 17"
 * @returns {Promise<boolean>}        - true on success, false on error
 */
export async function sendSignupRequest({ playerName, playerEmail, signupUrl, weekLabel }) {
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
 * Sends a session reminder to a single player.
 * Used for one-off manual sends. Batch reminder sends must use sendEmailBatch().
 *
 * @param {object} params
 * @param {string} params.playerName
 * @param {string} params.playerEmail
 * @param {string} params.sessionDate  - e.g. "Monday, May 12"
 * @param {string} params.startTime    - e.g. "8:00 AM"
 * @param {string} params.location
 * @param {string} [params.notes]      - Optional session notes
 * @param {string} params.cancelUrl    - Absolute URL for cancellation link
 * @returns {Promise<boolean>}
 */
export async function sendReminder({ playerName, playerEmail, sessionDate, startTime, location, notes, cancelUrl }) {
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
        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee;">
          <a href="${cancelUrl}" style="color: #888; font-size: 12px;">Can't make it? Cancel your spot</a>
        </div>
      </div>
    `
  })

  if (error) {
    console.error('sendReminder error:', error)
    return false
  }
  return true
}

/**
 * Sends a player cancellation notice to the organiser.
 * Single-recipient organiser alert — no batch needed.
 * Reads ADMIN_EMAIL from environment (comma-separated values supported).
 *
 * @param {object} params
 * @param {string} params.adminEmail   - From process.env.ADMIN_EMAIL
 * @param {string} params.playerName
 * @param {string} params.sessionDate
 * @param {string} params.location
 * @returns {Promise<boolean>}
 */
export async function sendCancellationNotice({ adminEmail, playerName, sessionDate, location }) {
  // resolveRecipient handles comma-separated admin email correctly in dev:
  // DEV_OVERRIDE replaces the whole value, which is fine for organiser emails.
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
// ---------------------------------------------------------------------------

/**
 * Notifies the organiser that a new week has been auto-created and is
 * waiting for their approval. Includes a direct link to the approval page.
 *
 * @param {object} params
 * @param {string} params.adminEmail     - From process.env.ADMIN_EMAIL
 * @param {string} params.weekId         - UUID of the newly created week record
 * @param {string} params.weekLabel      - e.g. "May 19 – May 24"
 * @param {string} params.approvalUrl    - Absolute URL to /admin/weeks/[id]/approve
 * @returns {Promise<boolean>}
 */
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

/**
 * Notifies the organiser that a previously pending week was automatically
 * deleted (hard-deleted, no data retained) because a new Monday cycle began
 * before it was approved.
 *
 * @param {object} params
 * @param {string} params.adminEmail       - From process.env.ADMIN_EMAIL
 * @param {string} params.dumpedWeekLabel  - e.g. "May 12 – May 17"
 * @returns {Promise<boolean>}
 */
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
// BATCH HELPER — all multi-recipient sends must use this
// ---------------------------------------------------------------------------

/**
 * Sends a single chunk of up to 100 pre-built Resend email objects.
 * Each item must be a complete Resend email object: { from, to, subject, html }.
 * Not exported — called internally by sendEmailBatch only.
 *
 * @param {object[]} emails
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function sendBatchChunk(emails) {
  const { data, error } = await resend.batch.send(emails)

  if (error) {
    console.error('sendBatchChunk error:', error)
    return { sent: 0, failed: emails.length }
  }

  return { sent: data.length, failed: emails.length - data.length }
}

/**
 * Chunks an array of email objects into batches of 100 and fires one Resend
 * batch API call per chunk. Required for all multi-recipient sends — individual
 * per-player API calls hit Resend's 5 req/s rate limit at group scale.
 *
 * If DEV_EMAIL_OVERRIDE is set, all 'to' fields in the batch are replaced
 * with the override address before sending.
 *
 * @param {object[]} emails - Array of complete Resend email objects
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function sendEmailBatch(emails) {
  const CHUNK_SIZE = 100

  // In dev, redirect every recipient in the batch to the override address.
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