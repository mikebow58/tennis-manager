/**
 * /api/admin/availability
 *
 * Admin-only availability management. Protected by auth middleware —
 * requires an authenticated session. No signup_token validation.
 *
 * POST: Add a player to a session (organiser manual add).
 * DELETE: Remove a player from a session (organiser manual remove).
 *
 * The DELETE handler behaviour depends on session status:
 *   - Pre-close (session.status = 'open'): hard-delete the availability record.
 *     No notifications, no sub request logic. Pre-close removals are quiet
 *     and reversible — see Phase 2 Section 7.3.
 *   - Post-close (session.status = 'closed'): transition availability to
 *     'cancelled' and trigger post-close cancellation logic (organiser alert
 *     + sub request evaluation). See Phase 2 Section 7.2 and Phase 3 Group 2.
 *
 * Distinct from /api/availability which is player-facing and requires
 * signup_token validation. Never merge these two routes.
 *
 * Tables read:  availability, sessions
 * Tables written: availability (delete or status update)
 * Side effects: post-close cancellation triggers lib/sub-requests.js
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { handlePostCloseCancellation } from '@/lib/sub-requests'

export async function POST(request) {
  console.log('[api/admin/availability] POST received')
  try {
    const body = await request.json()

    // body is an array of availability records: [{ session_id, player_id, status }]
    if (!Array.isArray(body) || body.length === 0) {
      console.warn('[api/admin/availability] POST: invalid body — expected non-empty array')
      return Response.json({ error: 'Invalid request body' }, { status: 400 })
    }

    console.log(`[api/admin/availability] POST: inserting ${body.length} availability record(s)`)

    const { error } = await supabaseAdmin
      .from('availability')
      .insert(body)

    if (error) {
      console.error('[api/admin/availability] POST: insert error:', error.message)
      return Response.json({ error: 'Error adding availability' }, { status: 500 })
    }

    console.log('[api/admin/availability] POST: insert successful')
    return Response.json({ success: true })
  } catch (err) {
    console.error('[api/admin/availability] POST: unexpected error:', err)
    return Response.json({ error: 'Unexpected error' }, { status: 500 })
  }
}

export async function DELETE(request) {
  console.log('[api/admin/availability] DELETE received')
  try {
    const { availabilityId } = await request.json()

    if (!availabilityId) {
      console.warn('[api/admin/availability] DELETE: missing availabilityId')
      return Response.json({ error: 'availabilityId required' }, { status: 400 })
    }

    // ------------------------------------------------------------------
    // Step 1: Fetch the availability record and its parent session status.
    // We need the session status to decide between hard-delete (pre-close)
    // and status-transition (post-close). We also fetch player and session
    // details here so they're available for the cancellation alert without
    // a second round-trip.
    // ------------------------------------------------------------------
    const { data: avail, error: fetchError } = await supabaseAdmin
      .from('availability')
      .select(`
        id,
        status,
        player_id,
        session_id,
        players ( first_name, last_name, email ),
        sessions (
          id,
          status,
          session_date,
          start_time,
          courts_available,
          locations ( name )
        )
      `)
      .eq('id', availabilityId)
      .single()

    if (fetchError || !avail) {
      console.error('[api/admin/availability] DELETE: record not found:', fetchError?.message)
      return Response.json({ error: 'Availability record not found' }, { status: 404 })
    }

    const sessionStatus = avail.sessions?.status
    const playerName = `${avail.players?.first_name} ${avail.players?.last_name}`.trim()
    console.log(
      `[api/admin/availability] DELETE: availabilityId=${availabilityId} ` +
      `sessionStatus=${sessionStatus} player="${playerName}"`
    )

    // ------------------------------------------------------------------
    // Step 2: Branch on session status.
    //
    // Pre-close (session.status = 'open'):
    //   Hard-delete the availability record. No notifications fire.
    //   The player can re-sign-up before the reminder sends.
    //
    // Post-close (session.status = 'closed'):
    //   Transition availability to 'cancelled'. Trigger the post-close
    //   cancellation flow (organiser alert + sub request evaluation).
    //
    // Any other status (cancelled session, etc.): still hard-delete to
    // allow the organiser to clean up rosters on cancelled sessions.
    // ------------------------------------------------------------------
    if (sessionStatus === 'open') {
      // Pre-close: quiet hard-delete. No downstream effects.
      console.log(
        `[api/admin/availability] DELETE: session is open — hard-deleting record ${availabilityId}`
      )

      const { error: deleteError } = await supabaseAdmin
        .from('availability')
        .delete()
        .eq('id', availabilityId)

      if (deleteError) {
        console.error('[api/admin/availability] DELETE: hard-delete error:', deleteError.message)
        return Response.json({ error: 'Error removing availability' }, { status: 500 })
      }

      console.log(`[api/admin/availability] DELETE: hard-delete complete for record ${availabilityId}`)
      return Response.json({ success: true, action: 'deleted' })

    } else if (sessionStatus === 'closed') {
      // Post-close: status transition + cancellation flow.
      console.log(
        `[api/admin/availability] DELETE: session is closed — transitioning record ${availabilityId} to cancelled`
      )

      // Transition availability status to 'cancelled'.
      const { error: updateError } = await supabaseAdmin
        .from('availability')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          court_assignment_status: null,
        })
        .eq('id', availabilityId)

      if (updateError) {
        console.error('[api/admin/availability] DELETE: status update error:', updateError.message)
        return Response.json({ error: 'Error cancelling availability' }, { status: 500 })
      }

      console.log(
        `[api/admin/availability] DELETE: availability ${availabilityId} transitioned to cancelled`
      )

      // Trigger post-close cancellation logic asynchronously.
      // This fires the organiser alert and evaluates sub request logic.
      // We do not await it — the route responds immediately and the
      // cancellation flow runs in the background. If it fails, the
      // availability status is already correctly set; the organiser
      // will see the cancelled record and can act manually.
     try {
        await handlePostCloseCancellation({
          sessionId: avail.session_id,
          cancelledPlayerId: avail.player_id,
          cancelledPlayerName: playerName,
          cancelledPlayerStatus: avail.status,
          session: avail.sessions,
        })
      } catch (err) {
        console.error(
          '[api/admin/availability] DELETE: post-close cancellation handler error:',
          err
        )
      }

      return Response.json({ success: true, action: 'cancelled' })

    } else {
      // Session is cancelled or in another non-actionable status.
      // Hard-delete to allow roster cleanup without triggering sub request logic.
      console.log(
        `[api/admin/availability] DELETE: session status is '${sessionStatus}' — hard-deleting record`
      )

      const { error: deleteError } = await supabaseAdmin
        .from('availability')
        .delete()
        .eq('id', availabilityId)

      if (deleteError) {
        console.error('[api/admin/availability] DELETE: hard-delete error:', deleteError.message)
        return Response.json({ error: 'Error removing availability' }, { status: 500 })
      }

      return Response.json({ success: true, action: 'deleted' })
    }

  } catch (err) {
    console.error('[api/admin/availability] DELETE: unexpected error:', err)
    return Response.json({ error: 'Unexpected error' }, { status: 500 })
  }
}