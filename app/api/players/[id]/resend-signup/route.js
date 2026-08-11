// app/api/players/[id]/resend-signup/route.js
//
// POST /api/players/[id]/resend-signup
//
// Organiser-only action (post-beta item #8 — "One-off signup email resend").
// Called from the "Resend signup link" button on the player edit page
// (app/players/[id]/page.js). Resends the current week's personalised
// signup link to this single player, using the existing single-recipient
// sendSignupRequest() function in lib/email.js — not the batch helper,
// since this is always exactly one recipient.
//
// Re-checks both preconditions live rather than trusting the caller: the
// button on the edit page is only shown enabled based on the canResendSignup
// flag returned by GET /api/players/[id], but that flag can go stale between
// page load and the organiser actually clicking — a week could close, or
// the player could be deactivated, in the interim.
//
// Preconditions (both re-verified here, not just on the client):
//   - Player is active.
//   - A week currently exists in 'sent' status. If more than one somehow
//     does at once (a prior week hasn't closed when a new one is sent —
//     sent -> closed only fires once all that week's sessions have passed),
//     the most recently sent week (highest signup_sent_at) is used — that's
//     the current live signup window from the organiser's perspective.
//
// Tables read: players, weeks
// Emails sent: sendSignupRequest (lib/email.js) — single recipient,
//   DEV_EMAIL_OVERRIDE applied automatically inside that function.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { sendSignupRequest } from '@/lib/email'

export async function POST(request, { params }) {
  const { id } = await params
  console.log(`[players/${id}/resend-signup] POST — received request`)

  // ------------------------------------------------------------------
  // Step 1: Fetch the player. Need signup_token (to build the URL),
  // email (recipient), first_name (email greeting), and active (guard).
  // ------------------------------------------------------------------
  const { data: player, error: playerError } = await supabaseAdmin
    .from('players')
    .select('id, first_name, last_name, email, active, signup_token')
    .eq('id', id)
    .single()

  if (playerError || !player) {
    console.error(`[players/${id}/resend-signup] POST — player not found:`, playerError?.message)
    return Response.json({ error: 'Player not found' }, { status: 404 })
  }

  if (!player.active) {
    console.warn(`[players/${id}/resend-signup] POST — rejected, player is inactive`)
    return Response.json({ error: 'This player is not active.' }, { status: 400 })
  }

  if (!player.email) {
    console.warn(`[players/${id}/resend-signup] POST — rejected, player has no email on file`)
    return Response.json({ error: 'This player has no email address on file.' }, { status: 400 })
  }

  // ------------------------------------------------------------------
  // Step 2: Find the current signup window. Most recently sent week —
  // see GET /api/players/[id] for why "most recent" matters here.
  // ------------------------------------------------------------------
  const { data: sentWeek, error: weekError } = await supabaseAdmin
    .from('weeks')
    .select('id, week_start_date, signup_sent_at')
    .eq('status', 'sent')
    .order('signup_sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (weekError) {
    console.error(`[players/${id}/resend-signup] POST — error querying sent week:`, weekError.message)
    return Response.json({ error: 'Error checking the current signup window.' }, { status: 500 })
  }

  if (!sentWeek) {
    console.warn(`[players/${id}/resend-signup] POST — rejected, no week is currently in 'sent' status`)
    return Response.json({ error: 'No signup window is currently open.' }, { status: 400 })
  }

  // ------------------------------------------------------------------
  // Step 3: Build the signup URL and week label, then send.
  // Date formatting matches the pattern used elsewhere in the app for
  // date-only fields (timeZone: 'UTC' avoids an off-by-one from local
  // browser/server timezone interpretation of a bare YYYY-MM-DD string).
  // ------------------------------------------------------------------
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  const signupUrl = `${baseUrl}/signup/${player.signup_token}`
  const weekLabel = new Date(sentWeek.week_start_date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

  const success = await sendSignupRequest({
    playerName: player.first_name,
    playerEmail: player.email,
    signupUrl,
    weekLabel,
  })

  if (!success) {
    console.error(`[players/${id}/resend-signup] POST — sendSignupRequest failed`)
    return Response.json({ error: 'Failed to send the email — try again.' }, { status: 500 })
  }

  console.log(
    `[players/${id}/resend-signup] POST — signup link resent to ${player.email} for week ${sentWeek.id}`
  )
  return Response.json({ success: true, weekLabel })
}