// app/api/subs/respond/route.js
//
// POST handler for the confirm/decline buttons on app/subs/respond/page.js.
// Runs the atomic claim_sub_request() database function, then — only on
// full completion of the broadcast — sends the promotion emails for any
// non-silently-demoted tentative players and one organiser notice.
// Always redirects back to the GET page (POST/redirect/GET), which
// re-renders from fresh DB state.
//
// BUG FIX (Gap 3, Aug 30 2026 session): added handling for the new
// SUCCESS_WAITLISTED outcome (see migration
// 20260830160000_fix_claim_sub_request_late_arrival_waitlist.sql). A late
// respondent is now silently placed on the waitlist by claim_sub_request()
// instead of being told the spot was already filled — this branch sends
// them the corresponding waitlist-confirmation email. No organiser email
// is sent for this event; the docs don't call for one, and the roster
// itself hasn't changed as a result of a late/waitlisted response.

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getAdminEmail } from '@/lib/admin-settings'
import {
  sendTentativePromotedToConfirmed,
  sendSubRequestResolvedNotice,
  sendAddedToWaitlistNotice,
} from '@/lib/email'

export async function POST(request) {
  const formData = await request.formData()
  const token = formData.get('token')
  const subId = formData.get('sub_id')
  const action = formData.get('action')

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  const redirectUrl =
    `${baseUrl}/subs/respond?token=${encodeURIComponent(token ?? '')}&sub_id=${subId ?? ''}`

  if (!token || !subId || !action) {
    console.error('[api/subs/respond] Missing token, sub_id, or action in form submission')
    return NextResponse.redirect(redirectUrl, { status: 303 })
  }

  console.log(`[api/subs/respond] action=${action} subId=${subId}`)

  const { data: result, error } = await supabaseAdmin.rpc('claim_sub_request', {
    p_signup_token: token,
    p_sub_id: Number(subId),
    p_action: action,
  })

  if (error) {
    console.error('[api/subs/respond] claim_sub_request RPC error:', error.message)
    return NextResponse.redirect(redirectUrl, { status: 303 })
  }

  console.log(`[api/subs/respond] result status=${result?.status}`)

  // Only on full completion: email promoted players who weren't silently
  // demoted, and send one organiser notice. Individual partial confirms
  // and declines do not generate organiser email — the organiser already
  // received the original cancellation alert with subsNeeded context, and
  // per-response emails for every partial fill would be noisy.
  if (result?.status === 'SUCCESS_COMPLETE') {
    const { data: session } = await supabaseAdmin
      .from('sub_requests')
      .select(`
        sessions (
          id,
          start_time,
          locations ( name ),
          location
        )
      `)
      .eq('id', Number(subId))
      .maybeSingle()

    const sessionRow = session?.sessions
    const locationName = sessionRow?.locations?.name ?? sessionRow?.location ?? 'TBD'

    const promotedPlayers = result.promoted_players ?? []
    for (const promoted of promotedPlayers) {
      if (!promoted.needs_email) {
        console.log(`[api/subs/respond] Skipping promotion email — player was silently demoted.`)
        continue
      }

      await sendTentativePromotedToConfirmed({
        playerFirstName: promoted.first_name,
        playerEmail: promoted.email,
        sessionDateLabel: result.session_date_label,
        locationName,
        startTime: sessionRow?.start_time,
        cancelUrl: `${baseUrl}/cancel/${promoted.signup_token}/${sessionRow?.id}`,
      }).catch((err) => {
        console.error('[api/subs/respond] promotion email failed:', err)
      })
    }

    const adminEmail = await getAdminEmail()
    if (adminEmail) {
      await sendSubRequestResolvedNotice({
        adminEmail,
        sessionDateLabel: result.session_date_label,
        locationName,
        filledByPlayerName: result.player_name,
      }).catch((err) => {
        console.error('[api/subs/respond] organiser resolved-notice email failed:', err)
      })
    }
  }

  // BUG FIX (Gap 3): a late respondent was silently placed on the
  // waitlist by claim_sub_request() rather than told the spot was
  // already filled. Send them the waitlist-confirmation email — first
  // name and email come directly from the RPC result (claim_sub_request
  // captures them from the players table during the same locked
  // transaction), avoiding a second round-trip query here.
  if (result?.status === 'SUCCESS_WAITLISTED') {
    const { data: session } = await supabaseAdmin
      .from('sub_requests')
      .select(`
        sessions (
          id,
          locations ( name ),
          location
        )
      `)
      .eq('id', Number(subId))
      .maybeSingle()

    const sessionRow = session?.sessions
    const locationName = sessionRow?.locations?.name ?? sessionRow?.location ?? 'TBD'

    if (result.player_email) {
      await sendAddedToWaitlistNotice({
        playerFirstName: result.player_first_name,
        playerEmail: result.player_email,
        sessionDateLabel: result.session_date_label,
        locationName,
      }).catch((err) => {
        console.error('[api/subs/respond] waitlist notice email failed:', err)
      })
    } else {
      console.error(
        '[api/subs/respond] SUCCESS_WAITLISTED but no player_email in RPC result — email not sent.'
      )
    }
  }

  return NextResponse.redirect(redirectUrl, { status: 303 })
}