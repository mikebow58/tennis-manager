// app/api/subs/respond/route.js
//
// POST handler for the confirm/decline buttons on app/subs/respond/page.js.
// Runs the atomic claim_sub_request() database function, then — only on
// full completion of the broadcast — sends the promotion emails for any
// non-silently-demoted tentative players and one organiser notice.
// Always redirects back to the GET page (POST/redirect/GET), which
// re-renders from fresh DB state.

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getAdminEmail } from '@/lib/admin-settings'
import {
  sendTentativePromotedToConfirmed,
  sendSubRequestResolvedNotice,
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

  return NextResponse.redirect(redirectUrl, { status: 303 })
}