// app/api/contact/route.js
//
// POST /api/contact
//
// Player-to-organiser messaging (post-beta item #9). Two modes:
//   - mode: 'token'     — player identified via signup_token (must be
//                          active, re-checked here — never trusted from
//                          the client). Name/email pulled from the
//                          verified player record.
//   - mode: 'anonymous' — no token available (broken/expired link case,
//                         or a stale token that already failed validation
//                         in app/contact/[token]/page.js). Name and email
//                         are whatever the visitor typed; cannot be
//                         verified against a player record.
//
// Fires a single immediate email to the organiser via
// sendPlayerContactSubmission (lib/email.js) — no notifications-table
// write, per organiser decision (matches Project Summary Section 5D's own
// classification of this as an Immediate Email Notification, not a
// Dashboard Notification Queue item).
//
// Tables read: players (token mode only)
// Emails sent: sendPlayerContactSubmission — single recipient (organiser)

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendPlayerContactSubmission } from '@/lib/email'
import { getAdminEmail } from '@/lib/admin-settings'

export async function POST(request) {
  console.log('[api/contact] POST — received request')

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { mode, message } = body

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return Response.json({ error: 'Message is required' }, { status: 400 })
  }

  let senderName
  let senderEmail
  let sourceLabel

  if (mode === 'token') {
    const { token } = body
    if (!token) {
      return Response.json({ error: 'Missing token' }, { status: 400 })
    }

    // Re-validate server-side — never trust a name/email the client might
    // supply. active = true required, same fix as the signup page
    // (post-beta item #11) — a deactivated player's stale link shouldn't
    // reach this path either.
    const { data: player, error: playerError } = await supabaseAdmin
      .from('players')
      .select('first_name, last_name, email')
      .eq('signup_token', token)
      .eq('active', true)
      .single()

    if (playerError || !player) {
      console.warn('[api/contact] POST — token mode, no matching active player')
      return Response.json({ error: 'Could not verify this link' }, { status: 400 })
    }

    senderName = `${player.first_name} ${player.last_name}`.trim()
    senderEmail = player.email
    sourceLabel = 'verified'
  } else if (mode === 'anonymous') {
    const { name, email } = body
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return Response.json({ error: 'Name is required' }, { status: 400 })
    }
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      return Response.json({ error: 'Email is required' }, { status: 400 })
    }
    senderName = name.trim()
    senderEmail = email.trim()
    sourceLabel = 'anonymous'
  } else {
    return Response.json({ error: 'Invalid mode' }, { status: 400 })
  }

  const adminEmail = await getAdminEmail()
  if (!adminEmail) {
    console.error('[api/contact] POST — getAdminEmail() returned no value, cannot send')
    return Response.json({ error: 'Could not send message — try again later' }, { status: 500 })
  }

  const success = await sendPlayerContactSubmission({
    adminEmail,
    senderName,
    senderEmail,
    message: message.trim(),
    sourceLabel,
  })

  if (!success) {
    return Response.json({ error: 'Failed to send message' }, { status: 500 })
  }

  console.log(`[api/contact] POST — message sent from ${senderName} (${sourceLabel})`)
  return Response.json({ success: true })
}