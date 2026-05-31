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
// V2 — APPROVAL REMINDER NOTIFICATIONS (used by wednesday_approval_reminder
// and thursday_urgent_reminder crons)
// ---------------------------------------------------------------------------

/**
 * Sends a standard (non-urgent) approval reminder to the organiser.
 * Fires on Wednesday morning if the upcoming week is still in pending_approval.
 * Visually identical to the week-created notification but with different
 * subject and body copy — no urgency language.
 *
 * @param {object} params
 * @param {string} params.adminEmail   - From process.env.ADMIN_EMAIL
 * @param {string} params.weekLabel    - e.g. "May 19 – May 24"
 * @param {string} params.approvalUrl  - Absolute URL to /admin/weeks/[id]/approve
 * @returns {Promise<boolean>}
 */
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

/**
 * Sends an URGENT approval reminder to the organiser.
 * Fires on Thursday morning if the upcoming week is still in pending_approval.
 * Visually distinct from the Wednesday reminder: red header, urgent subject
 * line prefix, explicit consequence stated (signup links will not go out).
 *
 * @param {object} params
 * @param {string} params.adminEmail   - From process.env.ADMIN_EMAIL
 * @param {string} params.weekLabel    - e.g. "May 19 – May 24"
 * @param {string} params.approvalUrl  - Absolute URL to /admin/weeks/[id]/approve
 * @returns {Promise<boolean>}
 */
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

  const sentCount = Array.isArray(data) ? data.length : (data?.data?.length ?? emails.length)
return { sent: sentCount, failed: emails.length - sentCount }
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

// ---------------------------------------------------------------------------
// sendSignupRequestBatch
// ---------------------------------------------------------------------------
// Sends personalised signup link emails to a list of active players in a
// single batch operation. Used exclusively by the friday_signup_send cron job.
//
// Each player receives a unique email containing their personal signup URL,
// built from their signup_token. The portal URL is also included so players
// can bookmark their permanent player portal.
//
// DEV_EMAIL_OVERRIDE: if set, ALL emails in the batch are redirected to that
// address regardless of the player's actual email. This prevents accidental
// sends to real players during dev/preview testing.
//
// @param {Array<{ playerFirstName: string, playerEmail: string, signupUrl: string, portalUrl: string }>} players//   Array of player objects. Each must have: playerName, playerEmail, signupUrl, portalUrl.
// @param {string} weekLabel  Human-readable week label, e.g. "May 19, 2026"
// @returns {Promise<{ sent: number, failed: number }>}
export async function sendSignupRequestBatch(players, weekLabel) {
  // Resolve the dev override address once up front — if set, every email in
  // the batch goes here instead of the real player address.
  const devOverride = process.env.DEV_EMAIL_OVERRIDE || null

  // Build one Resend email object per player. Each email is personalised with
  // the player's name and their unique signup URL.
  const emails = players.map((player) => ({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',

    // Redirect to dev override if set; otherwise send to the real player email.
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

        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee;">
          <p style="color: #aaa; font-size: 12px; margin: 0;">
            Your personal tennis page — bookmark it for quick access anytime:<br/>
            <a href="${player.portalUrl}" style="color: #2563eb;">${player.portalUrl}</a>
          </p>
        </div>
      </div>
    `,
  }))

  // Fire the batch through the shared helper, which chunks into groups of 100.
  return sendEmailBatch(emails)
}

// ---------------------------------------------------------------------------
// sendSignupSkippedNotification
// ---------------------------------------------------------------------------
// Sends an alert to the organiser when the friday_signup_send cron fires but
// the week is still in pending_approval status. Players have NOT been notified.
// Includes a direct link to the approval page so the organiser can act
// immediately from the email.
//
// DEV_EMAIL_OVERRIDE: if set, the alert goes to the override address. This
// mirrors the behaviour of all other organiser-facing emails during dev testing.
//
// @param {string} adminEmail  Organiser email address (from ADMIN_EMAIL env var).
//   Supports comma-separated values (same pattern as sendCancellationNotice).
// @param {string} weekLabel   Human-readable week label, e.g. "May 19, 2026"
// @param {string} weekId      UUID of the week record — used to build the approval link.
// @returns {Promise<boolean>} true if send succeeded, false if Resend returned an error.
export async function sendSignupSkippedNotification({ adminEmail, weekLabel, weekId }) {
  // Build the absolute approval URL. NEXT_PUBLIC_BASE_URL is the only safe
  // source — never hardcode the domain. Different values on dev vs production.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  const approvalUrl = `${baseUrl}/admin/weeks/${weekId}/approve`

  // Resolve the dev override. Organiser emails are single-recipient so we
  // apply the same override pattern used on the player batch sends above.
  const devOverride = process.env.DEV_EMAIL_OVERRIDE || null

  // Resolve recipient — support comma-separated ADMIN_EMAIL values exactly as
  // sendCancellationNotice does, then apply dev override on top if set.
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

/**
 * Sends the organiser a confirmation email when a week is approved
 * (approve path only — not used for approve_and_send, since the signup
 * send itself confirms that action).
 *
 * @param {object} params
 * @param {string} params.adminEmail  - Organiser email(s), comma-separated OK
 * @param {string} params.weekLabel   - Human-readable week label, e.g. "May 19, 2026"
 * @param {string} params.weekId      - Week UUID, used to build the approve page URL
 * @returns {Promise<boolean>} true on success, false on error
 */
export async function sendWeekApprovedNotification({ adminEmail, weekLabel, weekId }) {
  // Respect DEV_EMAIL_OVERRIDE — redirect all mail to developer address in Preview
  const recipient = DEV_OVERRIDE || (adminEmail.includes(',')
    ? adminEmail.split(',').map((e) => e.trim())
    : adminEmail)

  if (DEV_OVERRIDE) {
  console.log(`[email] DEV_EMAIL_OVERRIDE active — sendWeekApprovedNotification redirected to ${DEV_OVERRIDE}`)
}

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://gtcourts.com'
  // Direct link back to the approve page so organiser can make further edits
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
// ---------------------------------------------------------------------------

/**
 * Sends confirmed-tier reminder emails to a batch of players.
 * Called after Procedure 1 (initial court balancing) runs and determines
 * these players are on complete courts. Includes full session details for
 * single-location days. Multi-location days: location details are withheld
 * until Procedure 2 (final court assignment) — not yet built.
 *
 * Uses sendEmailBatch() which chunks into groups of 100 and applies
 * DEV_EMAIL_OVERRIDE automatically.
 *
 * @param {Array<{
 *   playerFirstName: string,
 *   playerEmail: string,
 *   sessionDate: string,
 *   startTime: string,
 *   locationName: string,
 *   notes: string|null,
 *   cancelUrl: string
 * }>} players
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function sendConfirmedReminderBatch(players) {
  const emails = players.map((player) => ({
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
        ${player.notes ? `<p style="color: #444; font-size: 14px;">${player.notes}</p>` : ''}
        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee;">
          <a href="${player.cancelUrl}" style="color: #888; font-size: 12px;">
            Can't make it? Cancel your spot
          </a>
        </div>
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

/**
 * Sends tentative-tier reminder emails to a batch of players.
 * Called after Procedure 1 determines these players are on incomplete courts.
 * Status-only message — no time, no location details, since the session is
 * short and those details are not yet finalised. Explicit 8pm deadline stated.
 *
 * Uses sendEmailBatch() which chunks into groups of 100 and applies
 * DEV_EMAIL_OVERRIDE automatically.
 *
 * @param {Array<{
 *   playerFirstName: string,
 *   playerEmail: string,
 *   sessionDate: string,
 *   deadlineLabel: string,
 *   cancelUrl: string
 * }>} players
 * @returns {Promise<{sent: number, failed: number}>}
 */
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
        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee;">
          <a href="${player.cancelUrl}" style="color: #888; font-size: 12px;">
            Can't make it? Let us know
          </a>
        </div>
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

// ---------------------------------------------------------------------------
// V2 — POST-CLOSE CANCELLATION ALERT (used by lib/sub-requests.js)
// ---------------------------------------------------------------------------

/**
 * Sends an immediate alert to the organiser when a player is removed from
 * a closed session. Includes current confirmed players, tentative players,
 * and a plain-English statement of what happens if the court cannot be filled.
 *
 * @param {object} params
 * @param {string} params.adminEmail           - From process.env.ADMIN_EMAIL (comma-sep OK)
 * @param {string} params.cancelledPlayerName  - e.g. "David Chen"
 * @param {string} params.cancelledPlayerStatus - 'confirmed' or 'tentative'
 * @param {string} params.sessionDateLabel     - e.g. "Wednesday, May 21"
 * @param {string} params.locationName         - e.g. "Memorial Park"
 * @param {number} params.confirmedCount       - Confirmed players after cancellation
 * @param {number} params.capacity             - Total session capacity (courts * 4)
 * @param {number} params.subsNeeded           - Number of subs required
 * @param {string} params.systemAction         - Human-readable description of system action taken
 * @param {string} [params.promotionSummary]   - Optional promotion summary (Case B)
 * @param {string[]} [params.confirmedPlayerNames] - Names of confirmed players
 * @param {string[]} [params.tentativePlayerNames] - Names of tentative players
 * @param {string} [params.deadlineLabel]      - e.g. "8:00pm" — deadline for filling the court
 * @returns {Promise<boolean>}
 */
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

  // Build the context paragraph explaining what the cancellation means.
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
    // Case B — confirmed cancelled, tentative player promoted.
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
    // Case C — confirmed cancelled from a perfectly full session.
    const subsText = subsNeeded === 1 ? '1 sub' : `${subsNeeded} subs`
    contextHtml = `
      <p style="color: #444; line-height: 1.6;">
        <strong>${cancelledPlayerName}</strong> cancelled their confirmed spot.
        The system is seeking ${subsText} to complete the court.
      </p>
    `
  } else if (subsNeeded === 0) {
    // Case D — cancellation resolved to perfectly filled courts.
    contextHtml = `
      <p style="color: #444; line-height: 1.6;">
        <strong>${cancelledPlayerName}</strong> cancelled, but the remaining players
        fill the courts perfectly. No replacement is needed.
      </p>
    `
  }

  // Build confirmed players list.
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

  // Build the deadline warning sentence — only shown when subs are needed.
  // Names the tentative players explicitly so the organiser knows who is at risk.
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

// ---------------------------------------------------------------------------
// V2 — SUB REQUEST BROADCAST STUB (used by lib/sub-requests.js)
// ---------------------------------------------------------------------------

/**
 * STUB: Placeholder for the sub request player broadcast.
 *
 * In production this function will send a targeted email to all available
 * players at the required skill level (via lib/targeting.js) asking them
 * to fill an open spot. That logic is not yet built.
 *
 * For now, this sends a summary notification to the organiser confirming
 * that a sub request record has been created and a broadcast would have
 * fired. This keeps the state machine correct and testable while targeting
 * logic is pending.
 *
 * REPLACE THIS STUB when lib/targeting.js is built. The sub_requests record
 * insert and staleness logic in lib/sub-requests.js stays unchanged —
 * only this email function needs to be replaced with the real targeting send.
 *
 * @param {object} params
 * @param {string} params.adminEmail      - From process.env.ADMIN_EMAIL (comma-sep OK)
 * @param {string} params.sessionDateLabel
 * @param {string} params.locationName
 * @param {number} params.openSpots
 * @param {string} params.subRequestId   - UUID of the newly created sub_requests record
 * @returns {Promise<boolean>}
 */
export async function sendSubRequestBroadcastStub({
  adminEmail,
  sessionDateLabel,
  locationName,
  openSpots,
  subRequestId,
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  console.log(
    `[email] sendSubRequestBroadcastStub: subRequestId=${subRequestId} ` +
    `openSpots=${openSpots} session="${sessionDateLabel}"`
  )

  const spotLabel = openSpots === 1 ? '1 open spot' : `${openSpots} open spots`

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `[DEV] Sub request created — ${sessionDateLabel} · ${spotLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #b45309; margin-bottom: 8px;">[Development stub] Sub request created</h2>

        <p style="color: #444; line-height: 1.6;">
          A sub request record has been created for <strong>${sessionDateLabel}</strong>
          at ${locationName} (${spotLabel}).
        </p>

        <div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <p style="color: #92400e; font-size: 13px; margin: 0;">
            <strong>Sub request ID:</strong> ${subRequestId}<br/>
            <strong>Status:</strong> In production, this would broadcast to all available
            players at the required skill level. Player targeting (lib/targeting.js)
            is not yet built — this stub will be replaced when it is.
          </p>
        </div>

        <p style="color: #888; font-size: 12px;">
          This email only appears in the development environment.
          It will not be sent in production once the targeting broadcast is implemented.
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('[email] sendSubRequestBroadcastStub error:', error)
    return false
  }
  return true
}

/**
 * Sent to a tentative player who has been promoted to confirmed status
 * after a post-close confirmed player cancellation.
 *
 * Per Phase 2 Section 7.2: confirmed players receive court assignment
 * details. Since Procedure 2 hasn't run yet at this point, we confirm
 * their status and provide session details without court assignment specifics.
 *
 * @param {object} params
 * @param {string} params.playerFirstName
 * @param {string} params.playerEmail
 * @param {string} params.sessionDateLabel   - e.g. "Wednesday, May 21"
 * @param {string} params.locationName
 * @param {string} params.startTime          - raw time string e.g. "09:00:00"
 * @param {string} params.cancelUrl
 * @returns {Promise<boolean>}
 */
export async function sendTentativePromotedToConfirmed({
  playerFirstName,
  playerEmail,
  sessionDateLabel,
  locationName,
  startTime,
  cancelUrl,
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

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          Can't make it? <a href="${cancelUrl}" style="color: #2563eb;">Cancel your spot</a>
        </p>
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
// V2 — ESCALATION NOTICE (used by daily_5pm_escalation cron)
// ---------------------------------------------------------------------------

/**
 * Sends an escalation notice to the organiser when a session is still short
 * at 5:00pm the day before. Read-only check — no DB writes. Includes
 * current roster context and a recommendation to begin manual outreach.
 *
 * @param {object} params
 * @param {string} params.adminEmail          - From process.env.ADMIN_EMAIL (comma-sep OK)
 * @param {string} params.sessionDateLabel    - e.g. "Wednesday, May 21"
 * @param {string} params.locationName        - e.g. "Memorial Park"
 * @param {string} params.startTime           - e.g. "9:00 AM"
 * @param {number} params.confirmedCount      - Current confirmed player count
 * @param {number} params.tentativeCount      - Current tentative player count
 * @param {number} params.subsNeeded          - Players needed to complete courts
 * @param {string|null} params.lastCancelledAt - ISO timestamp of most recent
 *   cancellation, or null if no cancellation has occurred post-close
 * @param {string|null} params.subRequestStatus - 'active' | 'closed' | null
 *   (null if no sub request exists for this session)
 * @param {string} params.deadlineLabel       - e.g. "8:00pm"
 * @returns {Promise<boolean>}
 */
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

  // Build a human-readable "time since last cancellation" string.
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

  // Sub request status summary.
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
// V2 — COURT ASSIGNMENT REVIEW (used by daily_6pm_court_assignment cron)
// ---------------------------------------------------------------------------

/**
 * Sends the organiser a court assignment review request when a session is
 * still short at 6:00pm. Includes current roster state, the number of
 * spots still needed, and an explicit 8pm backstop warning.
 *
 * Procedure 2 (full rebalancing algorithm) is not yet built — this email
 * describes the current state and asks the organiser to act. When
 * lib/court-assignment.js is built, additional court-specific detail
 * (recommended court arrangements) will be added to this email.
 *
 * @param {object} params
 * @param {string} params.adminEmail         - From process.env.ADMIN_EMAIL (comma-sep OK)
 * @param {string} params.sessionDateLabel   - e.g. "Wednesday, May 21"
 * @param {string} params.locationName
 * @param {string} params.startTime          - e.g. "9:00 AM"
 * @param {number} params.confirmedCount
 * @param {number} params.tentativeCount
 * @param {number} params.subsNeeded
 * @param {string} params.deadlineLabel      - e.g. "8:00pm"
 * @param {string[]} params.tentativePlayerNames - Names of tentative players at risk
 * @returns {Promise<boolean>}
 */
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
}) {
  const to = DEV_OVERRIDE
    ? DEV_OVERRIDE
    : adminEmail.includes(',')
      ? adminEmail.split(',').map((e) => e.trim())
      : adminEmail

  if (DEV_OVERRIDE) {
    console.log(`[email] DEV_EMAIL_OVERRIDE active — sendCourtAssignmentReview redirected to ${DEV_OVERRIDE}`)
  }

  const subsLabel = subsNeeded === 1 ? '1 player still needed' : `${subsNeeded} players still needed`

  // Names of players who will be dropped at 8pm if not filled.
  const atRiskHtml = tentativePlayerNames.length > 0
    ? `
      <p style="color: #444; line-height: 1.6; font-size: 14px;">
        If the court cannot be filled by ${deadlineLabel},
        <strong>${tentativePlayerNames.join(', ')}</strong>
        will be notified that ${tentativePlayerNames.length === 1 ? 'their spot has been cancelled' : 'their spots have been cancelled'}.
      </p>
    `
    : ''

  const { error } = await resend.emails.send({
    from: 'Treviso - Memorial Park <noreply@gtcourts.com>',
    to,
    subject: `Court assignment — ${sessionDateLabel} · ${subsLabel} · action by ${deadlineLabel}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #111; margin-bottom: 8px;">Court assignment — ${sessionDateLabel}</h2>

        <p style="color: #444; line-height: 1.6;">
          <strong>${sessionDateLabel}</strong> is still short at 6:00pm.
          The automated broadcast window is now closed.
          You have until <strong>${deadlineLabel}</strong> to add a player manually
          before the incomplete court is auto-cancelled.
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
        </div>

        ${atRiskHtml}

        <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="color: #991b1b; font-size: 14px; margin: 0;">
            <strong>Auto-cancel at ${deadlineLabel}:</strong> If you have not manually added a player
            by ${deadlineLabel}, the system will automatically cancel the incomplete court and
            notify affected players immediately.
          </p>
        </div>
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
// ---------------------------------------------------------------------------

/**
 * Sends court assignment details to a batch of confirmed players.
 * Called by the 8pm backstop when assignments have not been manually
 * approved by the organiser.
 *
 * NOTE: Full court-specific detail (court number, partners) requires
 * Procedure 2 (lib/court-assignment.js) to be built. Until then this
 * sends a confirmed-status email with session details and a note that
 * court assignment will be posted at the venue.
 *
 * Uses sendEmailBatch() — DEV_EMAIL_OVERRIDE applied automatically.
 *
 * @param {Array<{
 *   playerFirstName: string,
 *   playerEmail: string,
 *   sessionDate: string,
 *   startTime: string,
 *   locationName: string,
 *   notes: string|null,
 *   cancelUrl: string
 * }>} players
 * @returns {Promise<{sent: number, failed: number}>}
 */
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

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          Can't make it? <a href="${player.cancelUrl}" style="color: #2563eb;">Cancel your spot</a>
        </p>
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

/**
 * Sends a court cancellation notice to a batch of tentative players
 * whose court has been auto-cancelled at the 8pm backstop.
 * Message clearly states the player is not playing and not expected to attend.
 *
 * Uses sendEmailBatch() — DEV_EMAIL_OVERRIDE applied automatically.
 *
 * @param {Array<{
 *   playerFirstName: string,
 *   playerEmail: string,
 *   sessionDate: string,
 *   startTime: string,
 *   locationName: string
 * }>} players
 * @returns {Promise<{sent: number, failed: number}>}
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

        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 24px 0;">
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

        <p style="color: #444; line-height: 1.6;">
          We're sorry for the late notice.
        </p>
      </div>
    `,
  }))

  return sendEmailBatch(emails)
}

/**
 * Notifies the organiser when the 8pm backstop auto-cancels one or more
 * incomplete courts. Accurately describes what was sent to players —
 * session details only, not court-specific assignments (Procedure 2
 * not yet built).
 *
 * @param {object} params
 * @param {string} params.adminEmail
 * @param {string} params.sessionDateLabel
 * @param {string} params.locationName
 * @param {number} params.cancelledCourtPlayerCount
 * @param {number} params.confirmedCount
 * @param {string[]} params.cancelledPlayerNames
 * @returns {Promise<boolean>}
 */
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
          (time and location). Court assignment details will be available once
          the court assignment feature is built.
          If you find a replacement after this point, add them manually via the
          admin dashboard.
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