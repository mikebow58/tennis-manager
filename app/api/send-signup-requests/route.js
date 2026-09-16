/**
 * app/api/send-signup-requests/route.js
 *
 * Manual "Send signup requests" button — organiser-triggered send for a
 * given week, independent of the friday_signup_send cron.
 *
 * THIS REVISION (Sept 2026 session — Player page build):
 *   Refactored to call sendSignupRequestBatch() from lib/email.js instead
 *   of building the email HTML template inline and calling sendEmailBatch()
 *   directly. The inline template was a single-source-of-truth violation
 *   (dev rules Section 6: all email sends must go through lib/email.js) —
 *   this route was duplicating sendSignupRequestBatch's template rather
 *   than using it. Refactoring also gives this send the Player page
 *   footer link (`/signup/${token}`, bookmarkable, per organiser decision
 *   — state handoff Sept 11 2026) automatically, consistent with every
 *   other signup-request send path.
 *
 * FLAGGED, NOT FIXED: this route does not check week.status before
 * sending and updating to 'sent' — every other send path (friday-
 * signup-send cron, the pending_approval → sent state transition rules in
 * Phase 2 Section 3) gates on the week being in 'approved' status first.
 * If this route is reachable while a week is still in 'pending_approval',
 * it would send unapproved sessions to players. Whether that's actually
 * reachable depends on whether the calling UI (SendSignupButton.js) only
 * renders this action once approved — not confirmed either way this
 * session. Left as-is since fixing it wasn't part of this task and would
 * change behavior beyond what was asked; worth a deliberate look next
 * time this route is touched.
 */

import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { sendSignupRequestBatch } from '@/lib/email'

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

  // Build one payload per eligible player, matching the shape
  // sendSignupRequestBatch expects (playerFirstName, playerEmail,
  // signupUrl, playerPageUrl) — same field names used by the
  // friday-signup-send cron's payload, so both callers of
  // sendSignupRequestBatch stay in sync.
  const playerPayloads = []
  for (const player of players) {
    if (!player.email || !player.signup_token) {
      skipped++
      continue
    }
    playerPayloads.push({
      playerFirstName: player.first_name,
      playerEmail: player.email,
      signupUrl: `${baseUrl}/signup/${player.signup_token}`,
      playerPageUrl: `${baseUrl}/signup/${player.signup_token}`,
    })
  }

  const { sent, failed } = await sendSignupRequestBatch(playerPayloads, weekLabel)

  await supabase
    .from('weeks')
    .update({
      status: 'sent',
      signup_sent_at: new Date().toISOString()
    })
    .eq('id', weekId)

  return Response.json({ success: true, results: { sent, failed, skipped } })
}