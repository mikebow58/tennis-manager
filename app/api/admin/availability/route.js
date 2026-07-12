/**
 * /api/admin/availability
 *
 * Admin-only availability management. Protected by auth middleware —
 * requires an authenticated session. No signup_token validation.
 *
 * POST: Add a player to a session (organiser manual add).
 *   PRE-CLOSE (session.status = 'open'): unchanged from before this
 *   revision — simple insert, no capacity check. Per Phase 2 Section 5.6
 *   ("Full uses >= rather than = ... organiser manual adds can push
 *   confirmed_count above capacity") and the system-never-blocks-the-
 *   organiser principle, pre-close admin adds are intentionally not routed
 *   through waitlist logic the way player self-signups are (Phase 2).
 *
 *   POST-CLOSE (session.status = 'closed') — NEW this revision, Phase 6 of
 *   the unified dynamic waitlist build sequence. This is the organiser-add
 *   equivalent of "a late respondent filling an open sub-request spot,"
 *   built now because the actual player-facing confirm/decline broadcast
 *   mechanism doesn't exist yet (deferred at Phase 4) and manual add via
 *   this route is currently the ONLY real path by which a post-close spot
 *   ever gets filled. Recomputes tentative count fresh from the DB (not
 *   any client-supplied value) and branches three ways:
 *
 *     1. tentativeCount === 0 (session already fully resolved — no
 *        incomplete court exists): new player inserted as 'waitlisted',
 *        landing at the bottom of the FIFO queue via default created_at.
 *        This is the race-condition case — the organiser believed they
 *        were filling an open spot but it was already resolved by another
 *        path between decision and submission. An organiser ALERT fires
 *        here specifically, mirroring the Phase 2 Section 7.4 pattern for
 *        cancelled/declined → waitlisted override races.
 *
 *     2. subsNeeded === 1 (this add exactly completes the incomplete
 *        court(s)): new player inserted as 'confirmed'. All existing
 *        tentative players on the session promote to 'confirmed' in the
 *        same action (mirrors Case D in lib/sub-requests.js). Active
 *        sub_requests row closed with filled_at = now() and
 *        filled_by_player_id = new player. Promoted (previously-tentative)
 *        players receive sendTentativePromotedToConfirmed, matching Case D
 *        exactly. The newly-added player does NOT receive an automated
 *        email — the organiser recruited them directly and is assumed to
 *        have already communicated with them, consistent with the existing
 *        "organiser handles communication directly" convention for manual
 *        adds (Phase 2 Section 7.4).
 *
 *     3. subsNeeded > 1 (this add helps but does not fully resolve): new
 *        player inserted as 'tentative', joining the existing tentative
 *        pool. No promotion, no sub_requests closure, no emails — the
 *        organiser is mid-recruitment and already aware of the state.
 *
 *   subsNeeded uses the same (4 - tentativeCount % 4) % 4 formula as
 *   lib/sub-requests.js, with the same "if 0, treat as 4" fallback for the
 *   edge case where tentativeCount is a nonzero multiple of 4 (multiple
 *   simultaneous incomplete courts) — NOT to be confused with
 *   tentativeCount === 0 itself, which is the distinct "already resolved"
 *   case handled separately above.
 *
 * DELETE: Remove a player from a session (organiser manual remove).
 *   Unchanged from Phase 3 — pre-close removal triggers
 *   promoteFromWaitlistIfOpenSpot; post-close removal triggers
 *   handlePostCloseCancellation.
 *
 * Distinct from /api/availability which is player-facing and requires
 * signup_token validation. Never merge these two routes.
 *
 * Tables read:  availability, sessions, sub_requests
 * Tables written: availability (insert, delete, status update, or
 *   promotion update), sub_requests (closure on full resolution)
 * Side effects: post-close cancellation triggers lib/sub-requests.js;
 *   pre-close removal of a confirmed player triggers
 *   lib/waitlist-promotion.js; post-close manual add resolving an
 *   incomplete court triggers the same promotion emails as Case D.
 *
 * References:
 *   Phase 3 Group 3 — sub request outcomes → availability records
 *     (first eligible respondent confirms; late respondent waitlisted)
 *   Phase 2 Section 7.4 — organiser override race-condition ALERT pattern
 *   lib/sub-requests.js — Case D (mirrored logic for full-resolution
 *     promotion + sub_requests closure)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { handlePostCloseCancellation } from '@/lib/sub-requests'
import { promoteFromWaitlistIfOpenSpot } from '@/lib/waitlist-promotion'
import { sendTentativePromotedToConfirmed, sendAdminAddRaceAlert } from '@/lib/email'
import { getAdminEmail } from '@/lib/admin-settings'

export async function POST(request) {
  console.log('[api/admin/availability] POST received')
  try {
    const body = await request.json()

    if (!Array.isArray(body) || body.length === 0) {
      console.warn('[api/admin/availability] POST: invalid body — expected non-empty array')
      return Response.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const results = []

    // Processed sequentially (not in parallel) — deliberate, so that if a
    // single POST call ever contains multiple adds targeting the SAME
    // session, each subsequent item sees the effects of the ones before it
    // (fresh tentative count, updated sub_requests state). Organiser adds
    // are low-volume (typically one player at a time via the admin UI), so
    // sequential processing has no meaningful performance cost.
    for (const record of body) {
      const { session_id, player_id, status: clientStatus } = record

      const { data: session, error: sessionFetchError } = await supabaseAdmin
        .from('sessions')
        .select('id, status, session_date, start_time, courts_available, locations ( name )')
        .eq('id', session_id)
        .single()

      if (sessionFetchError || !session) {
        console.error(
          `[api/admin/availability] POST: could not fetch session ${session_id}:`,
          sessionFetchError?.message
        )
        results.push({ session_id, player_id, error: 'Session not found' })
        continue
      }

      if (session.status !== 'closed') {
        // Pre-close (or any other status): unchanged behaviour — simple
        // insert, trusting the admin UI's supplied status. No capacity
        // check, per the system-never-blocks-the-organiser principle and
        // Phase 2 Section 5.6.
        const { error: insertError } = await supabaseAdmin
          .from('availability')
          .insert({ session_id, player_id, status: clientStatus ?? 'confirmed' })

        if (insertError) {
          console.error(
            `[api/admin/availability] POST: insert error (pre-close) for session ${session_id}:`,
            insertError.message
          )
          results.push({ session_id, player_id, error: 'Error adding availability' })
        } else {
          results.push({ session_id, player_id, status: clientStatus ?? 'confirmed' })
        }
        continue
      }

      // ------------------------------------------------------------------
      // POST-CLOSE — Phase 6 capacity-aware branching.
      // ------------------------------------------------------------------
      const { data: tentativeRows, error: tentativeFetchError } = await supabaseAdmin
        .from('availability')
        .select(`
          id, player_id,
          players ( first_name, email, signup_token )
        `)
        .eq('session_id', session_id)
        .eq('status', 'tentative')
        .order('created_at', { ascending: true })

      if (tentativeFetchError) {
        console.error(
          `[api/admin/availability] POST: error fetching tentative players for session ${session_id}:`,
          tentativeFetchError.message
        )
        results.push({ session_id, player_id, error: 'Error checking session state' })
        continue
      }

      const tentativeCount = tentativeRows.length

      // ------------------------------------------------------------------
      // CASE: session already fully resolved (no incomplete court exists).
      // Race condition — organiser expected an open spot; none exists.
      // New player → waitlisted, bottom of FIFO queue. Organiser ALERTED.
      // ------------------------------------------------------------------
      if (tentativeCount === 0) {
        console.log(
          `[api/admin/availability] POST: session ${session_id} already resolved (0 tentative). ` +
          `Inserting player ${player_id} as waitlisted.`
        )

        const { error: insertError } = await supabaseAdmin
          .from('availability')
          .insert({ session_id, player_id, status: 'waitlisted' })

        if (insertError) {
          console.error(
            `[api/admin/availability] POST: waitlisted insert error for session ${session_id}:`,
            insertError.message
          )
          results.push({ session_id, player_id, error: 'Error adding availability' })
          continue
        }

        const { data: playerRow } = await supabaseAdmin
          .from('players')
          .select('first_name, last_name')
          .eq('id', player_id)
          .single()

        const addedPlayerName = playerRow
          ? `${playerRow.first_name} ${playerRow.last_name}`.trim()
          : 'The player'

        const sessionDateLabel = session.session_date
          ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
            })
          : 'Unknown date'
        const locationName = session.locations?.name ?? 'TBD'

        const adminEmail = await getAdminEmail()
        if (adminEmail) {
          await sendAdminAddRaceAlert({
            adminEmail,
            addedPlayerName,
            sessionDateLabel,
            locationName,
          }).catch((err) =>
            console.error('[api/admin/availability] POST: race alert email failed:', err)
          )
        }

        results.push({ session_id, player_id, status: 'waitlisted', note: 'session_already_resolved' })
        continue
      }

      // ------------------------------------------------------------------
      // subsNeeded formula matches lib/sub-requests.js Case A/B exactly,
      // including the "if 0, treat as 4" fallback for the edge case where
      // tentativeCount is a nonzero multiple of 4 (multiple simultaneous
      // incomplete courts). Distinct from tentativeCount === 0 above.
      // ------------------------------------------------------------------
      let subsNeeded = (4 - (tentativeCount % 4)) % 4
      if (subsNeeded === 0) subsNeeded = 4

      if (subsNeeded === 1) {
        // ------------------------------------------------------------------
        // CASE: this add exactly completes the incomplete court(s).
        // New player → confirmed. All existing tentative players promote
        // to confirmed in the same action (mirrors Case D). sub_requests
        // closed with filled_at + filled_by_player_id. No email to the
        // newly-added player — organiser recruited them directly.
        // ------------------------------------------------------------------
        console.log(
          `[api/admin/availability] POST: session ${session_id} — add completes the court. ` +
          `Promoting player ${player_id} plus ${tentativeCount} existing tentative player(s).`
        )

        const { error: insertError } = await supabaseAdmin
          .from('availability')
          .insert({ session_id, player_id, status: 'confirmed', court_assignment_status: 'confirmed' })

        if (insertError) {
          console.error(
            `[api/admin/availability] POST: confirmed insert error for session ${session_id}:`,
            insertError.message
          )
          results.push({ session_id, player_id, error: 'Error adding availability' })
          continue
        }

        const tentativeIds = tentativeRows.map((r) => r.id)
        const { error: promoteError } = await supabaseAdmin
          .from('availability')
          .update({ status: 'confirmed', court_assignment_status: 'confirmed' })
          .in('id', tentativeIds)

        if (promoteError) {
          console.error(
            `[api/admin/availability] POST: error promoting tentative players for session ${session_id}:`,
            promoteError.message
          )
        }

        // Close the active sub_requests row, if any, with fill details.
        const { data: activeSubRequest } = await supabaseAdmin
          .from('sub_requests')
          .select('id')
          .eq('session_id', session_id)
          .eq('status', 'active')
          .order('sent_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (activeSubRequest) {
          await supabaseAdmin
            .from('sub_requests')
            .update({
              status: 'closed',
              filled_at: new Date().toISOString(),
              filled_by_player_id: player_id,
            })
            .eq('id', activeSubRequest.id)
        }

        // Email the previously-tentative players who were just promoted —
        // NOT the newly-added player.
        const sessionDateLabel = session.session_date
          ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
            })
          : 'Unknown date'
        const locationName = session.locations?.name ?? 'TBD'
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

        for (const t of tentativeRows) {
          if (!t.players?.email) continue
          await sendTentativePromotedToConfirmed({
            playerFirstName: t.players.first_name,
            playerEmail: t.players.email,
            sessionDateLabel,
            locationName,
            startTime: session.start_time,
            cancelUrl: `${baseUrl}/cancel/${t.players.signup_token}/${session_id}`,
          }).catch((err) =>
            console.error(
              `[api/admin/availability] POST: promotion email failed for ${t.players.email}:`, err
            )
          )
        }

        results.push({ session_id, player_id, status: 'confirmed', note: 'completed_court', promoted: tentativeIds.length })
        continue
      }

      // ------------------------------------------------------------------
      // CASE: this add helps but does not fully resolve the incomplete
      // court(s). New player → tentative, joining the existing pool.
      // No promotion, no sub_requests closure, no emails.
      // ------------------------------------------------------------------
      console.log(
        `[api/admin/availability] POST: session ${session_id} — add does not fully resolve ` +
        `(subsNeeded was ${subsNeeded}). Inserting player ${player_id} as tentative.`
      )

      const { error: insertError } = await supabaseAdmin
        .from('availability')
        .insert({ session_id, player_id, status: 'tentative', court_assignment_status: 'tentative' })

      if (insertError) {
        console.error(
          `[api/admin/availability] POST: tentative insert error for session ${session_id}:`,
          insertError.message
        )
        results.push({ session_id, player_id, error: 'Error adding availability' })
        continue
      }

      results.push({ session_id, player_id, status: 'tentative', note: 'partial_fill' })
    }

    console.log('[api/admin/availability] POST: processing complete', JSON.stringify(results))
    return Response.json({ success: true, results })
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

    if (sessionStatus === 'open') {
      console.log(
        `[api/admin/availability] DELETE: session is open — hard-deleting record ${availabilityId}`
      )

      const priorStatus = avail.status

      const { error: deleteError } = await supabaseAdmin
        .from('availability')
        .delete()
        .eq('id', availabilityId)

      if (deleteError) {
        console.error('[api/admin/availability] DELETE: hard-delete error:', deleteError.message)
        return Response.json({ error: 'Error removing availability' }, { status: 500 })
      }

      console.log(`[api/admin/availability] DELETE: hard-delete complete for record ${availabilityId}`)

      if (priorStatus === 'confirmed') {
        try {
          await promoteFromWaitlistIfOpenSpot({
            sessionId: avail.session_id,
            cancelledPlayerName: playerName,
            notifyOrganiser: false,
          })
        } catch (err) {
          console.error(
            `[api/admin/availability] DELETE: promotion check failed for session ${avail.session_id}:`, err
          )
        }
      }

      return Response.json({ success: true, action: 'deleted' })

    } else if (sessionStatus === 'closed') {
      console.log(
        `[api/admin/availability] DELETE: session is closed — transitioning record ${availabilityId} to cancelled`
      )

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