/**
 * POST /api/weeks/[id]/approve
 *
 * Handles both approval transitions for a week in pending_approval status.
 *
 * Supported actions (passed in request body):
 *   "approve"          — pending_approval → approved
 *                        Sets weeks.approved_at. No player emails.
 *                        Used when the organiser approves before the Friday
 *                        signup send time has passed.
 *
 *   "approve_and_send" — pending_approval → sent
 *                        Single transaction: sets both approved_at and
 *                        signup_sent_at simultaneously, then sends personalised
 *                        signup emails to all active players.
 *                        Used when the organiser acts after the Friday send
 *                        time has already passed (Phase 2 Section 3.2).
 *
 * Guards:
 *   - Week must be in pending_approval status. Any other status returns 409.
 *   - approve_and_send uses a single DB write before sending emails, preventing
 *     the friday_signup_send cron from racing between the two writes.
 *
 * Tables touched:
 *   weeks (read + update)
 *   players (read — approve_and_send only)
 *
 * Emails sent:
 *   Organiser: approval confirmation (both actions)
 *   All active players: personalised signup links (approve_and_send only)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendWeekApprovedNotification,
  sendSignupRequestBatch,
} from '@/lib/email'

export async function POST(request, { params }) {
  const startTime = Date.now()
  const { id: weekId } = await params

  console.log(`[approve] POST /api/weeks/${weekId}/approve — received at ${new Date().toISOString()}`)

  // ── Parse request body ───────────────────────────────────────────────────
  let body
  try {
    body = await request.json()
  } catch {
    console.error('[approve] Failed to parse request body')
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { action } = body

  // Validate action value — only two accepted values
  if (action !== 'approve' && action !== 'approve_and_send') {
    console.error(`[approve] Unknown action: "${action}"`)
    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }

  console.log(`[approve] Action: "${action}"`)

  // ── Fetch current week ───────────────────────────────────────────────────
  const { data: week, error: weekError } = await supabaseAdmin
    .from('weeks')
    .select('id, status, week_start_date')
    .eq('id', weekId)
    .single()

  if (weekError || !week) {
    console.error('[approve] Week not found:', weekError)
    return Response.json({ error: 'Week not found' }, { status: 404 })
  }

  console.log(`[approve] Week found — status: "${week.status}", week_start_date: ${week.week_start_date}`)

  // ── Guard: week must be in pending_approval ──────────────────────────────
  // Any other status means the week has already moved forward — do not
  // overwrite it. Return 409 Conflict so the UI can show a clear message.
  if (week.status !== 'pending_approval') {
    console.warn(`[approve] Week status is "${week.status}" — cannot approve. Returning 409.`)
    return Response.json(
      { error: `Week is already in "${week.status}" status and cannot be approved again.` },
      { status: 409 }
    )
  }

  // ── Build week label for emails ──────────────────────────────────────────
  const weekLabel = new Date(week.week_start_date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

  // ── Branch: approve (pending_approval → approved) ────────────────────────
  if (action === 'approve') {
    console.log('[approve] Executing approve path — updating weeks.status to "approved"')

    const { error: updateError } = await supabaseAdmin
      .from('weeks')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
      })
      .eq('id', weekId)

    if (updateError) {
      console.error('[approve] DB update failed:', updateError)
      return Response.json({ error: 'Failed to approve week' }, { status: 500 })
    }

    console.log('[approve] weeks.status → "approved" written successfully')

    // Notify organiser that the week has been approved and the friday cron
    // will send signup links automatically on the scheduled day.
    const adminEmail = process.env.ADMIN_EMAIL
    if (adminEmail) {
      await sendWeekApprovedNotification({ adminEmail, weekLabel, weekId })
      console.log('[approve] Organiser approval confirmation email sent')
    } else {
      console.warn('[approve] ADMIN_EMAIL not set — skipping organiser notification')
    }

    const duration = Date.now() - startTime
    console.log(`[approve] Approve path complete — duration: ${duration}ms`)
    return Response.json({ success: true, newStatus: 'approved' })
  }

  // ── Branch: approve_and_send (pending_approval → sent) ───────────────────
  // Single transaction: write both approved_at and signup_sent_at before
  // sending any emails. This prevents the friday_signup_send cron from racing
  // between the two writes and triggering a double-send.
  console.log('[approve] Executing approve_and_send path — writing "sent" status atomically')

  const now = new Date().toISOString()

  const { error: updateError } = await supabaseAdmin
    .from('weeks')
    .update({
      status: 'sent',
      approved_at: now,
      signup_sent_at: now,
    })
    .eq('id', weekId)

  if (updateError) {
    console.error('[approve] DB update failed (approve_and_send):', updateError)
    return Response.json({ error: 'Failed to approve and send week' }, { status: 500 })
  }

  console.log('[approve] weeks.status → "sent" written successfully (approved_at + signup_sent_at set)')

  // Fetch all active players to build the signup email list.
  // Inactive players never receive signup links.
  const { data: players, error: playersError } = await supabaseAdmin
    .from('players')
    .select('id, first_name, email, signup_token')
    .eq('active', true)

  if (playersError) {
    // DB write already succeeded — week is in "sent" status.
    // Log the error but don't return a failure response; the organiser
    // can manually resend from the dashboard if needed.
    console.error('[approve] Failed to fetch players for signup send:', playersError)
    return Response.json({
      success: true,
      newStatus: 'sent',
      warning: 'Week marked as sent but player emails could not be fetched. Manual resend may be needed.',
    })
  }

  console.log(`[approve] Fetched ${players.length} active players for signup send`)

  // Build the base URL for personalised signup links — must use env variable,
  // never hardcoded, so dev preview and production both work correctly.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://gtcourts.com'

  // Build signup email array — one entry per active player
  const signupEmails = players
  .filter((p) => p.email && p.signup_token)
  .map((p) => ({
    playerFirstName: p.first_name,
    playerEmail: p.email,
    signupUrl: `${baseUrl}/signup/${p.signup_token}`,
    // portalUrl is included in the signup email footer so players can bookmark it
    portalUrl: `${baseUrl}/signup/${p.signup_token}`,
  }))

  console.log(`[approve] Sending signup emails to ${signupEmails.length} players`)

  const { sent, failed } = await sendSignupRequestBatch(signupEmails, weekLabel)

  console.log(`[approve] Signup email send complete — sent: ${sent}, failed: ${failed}`)

  if (failed > 0) {
    console.warn(`[approve] ${failed} signup emails failed to send`)
  }

  const duration = Date.now() - startTime
  console.log(`[approve] Approve-and-send path complete — duration: ${duration}ms`)

  return Response.json({
    success: true,
    newStatus: 'sent',
    emailsSent: sent,
    emailsFailed: failed,
  })
}