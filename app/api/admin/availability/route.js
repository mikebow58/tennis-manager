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
 *   POST-CLOSE (session.status = 'closed'): Phase 6 of the unified dynamic
 *   waitlist build sequence. This is the organiser-add equivalent of "a
 *   late respondent filling an open sub-request spot," built because the
 *   actual player-facing confirm/decline broadcast mechanism didn't exist
 *   yet at the time (since built — see lib/sub-requests.js). Recomputes
 *   tentative count fresh from the DB (not any client-supplied value) and
 *   branches three ways:
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
 *   ALL insert branches above now also set availability.organiser_added =
 *   true (NEW this revision — see DELETE section below for why this
 *   matters). Every insert through this route is, by definition, an
 *   organiser manual add — this route is never reachable from a player's
 *   own signup action (that's /api/availability, a separate route with
 *   signup_token validation) — so every insert here qualifies unconditionally.
 *
 * DELETE: Remove a player from a session (organiser manual remove).
 *   POST-CLOSE: unchanged — transitions to 'cancelled' and triggers
 *   handlePostCloseCancellation, same as always.
 *
 *   PRE-CLOSE (session.status = 'open') — NEW this revision. Per Phase 2
 *   Section 7.3, a pre-close removal is normally a quiet, silent hard-delete
 *   with no organiser notification — by design, since most pre-close
 *   removals are just players changing their own mind and the organiser
 *   doesn't need to know about ordinary roster churn.
 *
 *   The exception: if the record being removed has organiser_added = true
 *   (the organiser personally recruited and added this player), and the
 *   PLAYER is the one removing themselves afterward, the organiser has a
 *   real interest in knowing — they went out of their way to get this
 *   person on the roster, and silently losing that effort without any
 *   signal is the gap this closes (Project Summary Section 21, "Organiser-
 *   added player removal notification").
 *
 *   The hard-delete itself is unchanged in either case — this only adds an
 *   email alongside it when organiser_added is true. Post-close removals of
 *   an organiser-added player are NOT specially handled here; standard
 *   cancellation procedures already apply post-close regardless of how the
 *   player originally joined the roster, per the original spec ("Standard
 *   cancellation procedures apply post-close; this covers the pre-close
 *   gap only").
 *
 * Distinct from /api/availability which is player-facing and requires
 * signup_token validation. Never merge these two routes.
 *
 * Tables read:  availability, sessions, sub_requests
 * Tables written: availability (insert incl. organiser_added, delete,
 *   status update, or promotion update), sub_requests (closure on full
 *   resolution)
 * Side effects: post-close cancellation triggers lib/sub-requests.js;
 *   pre-close removal of a confirmed player triggers
 *   lib/waitlist-promotion.js; pre-close removal of an organiser-added
 *   player additionally triggers an immediate organiser email (NEW); post-
 *   close manual add resolving an incomplete court triggers the same
 *   promotion emails as Case D.
 *
 * References:
 *   Phase 3 Group 3 — sub request outcomes → availability records
 *     (first eligible respondent confirms; late respondent waitlisted)
 *   Phase 2 Section 7.3 — pre-close removal is quiet and reversible (the
 *     general rule this route's DELETE handler follows, except for the
 *     organiser_added case carved out above)
 *   Phase 2 Section 7.4 — organiser override race-condition ALERT pattern
 *   lib/sub-requests.js — Case D (mirrored logic for full-resolution
 *     promotion + sub_requests closure)
 *   Project Summary Section 21 — "Organiser-added player removal
 *     notification" (the feature this revision implements)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { handlePostCloseCancellation } from '@/lib/sub-requests'
import { promoteFromWaitlistIfOpenSpot } from '@/lib/waitlist-promotion'
import {
  sendTentativePromotedToConfirmed,
  sendAdminAddRaceAlert,
  sendOrganiserAddedPlayerRemovedAlert,
} from '@/lib/email'
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
        // Phase 2 Section 5.6. organiser_added: true set unconditionally —
        // every insert through this route is an organiser manual add.
        const { error: insertError } = await supabaseAdmin
          .from('availability')
          .insert({ session_id, player_id, status: clientStatus ?? 'confirmed', organiser_added: true })

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
      // POST-CLOSE — capacity-aware branching.
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
          .insert({ session_id, player_id, status: 'waitlisted', organiser_added: true })

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
          .insert({
            session_id,
            player_id,
            status: 'confirmed',
            court_assignment_status: 'confirmed',
            organiser_added: true,
          })

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
        .insert({
          session_id,
          player_id,
          status: 'tentative',
          court_assignment_status: 'tentative',
          organiser_added: true,
        })

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

    // organiser_added now included in this select — required to decide
    // whether the pre-close branch below needs to fire the new alert.
    const { data: avail, error: fetchError } = await supabaseAdmin
      .from('availability')
      .select(`
        id,
        status,
        player_id,
        session_id,
        organiser_added,
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
      `sessionStatus=${sessionStatus} player="${playerName}" organiserAdded=${avail.organiser_added}`
    )

    if (sessionStatus === 'open') {
      console.log(
        `[api/admin/availability] DELETE: session is open — hard-deleting record ${availabilityId}`
      )

      const priorStatus = avail.status
      const wasOrganiserAdded = avail.organiser_added === true

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

      // ------------------------------------------------------------------
      // NEW: organiser-added player removal notification.
      // The delete above is unchanged either way — this only adds an email
      // alongside it when the record being removed was originally added by
      // the organiser (organiser_added = true). Normal pre-close removals
      // (organiser_added = false) remain silent per Phase 2 Section 7.3.
      // ------------------------------------------------------------------
      if (wasOrganiserAdded) {
        console.log(
          `[api/admin/availability] DELETE: record ${availabilityId} was organiser-added — ` +
          `firing immediate organiser alert.`
        )

        const sessionDateLabel = avail.sessions?.session_date
          ? new Date(avail.sessions.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
            })
          : 'Unknown date'
        const locationName = avail.sessions?.locations?.name ?? 'TBD'

        const adminEmail = await getAdminEmail()
        if (adminEmail) {
          await sendOrganiserAddedPlayerRemovedAlert({
            adminEmail,
            playerName,
            sessionDateLabel,
            locationName,
          }).catch((err) =>
            console.error(
              '[api/admin/availability] DELETE: organiser-added removal alert email failed:', err
            )
          )
        } else {
          console.error(
            '[api/admin/availability] DELETE: getAdminEmail() returned no value — ' +
            'organiser-added removal alert skipped.'
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

      // Standard cancellation procedures apply post-close regardless of
      // organiser_added — per spec, this feature covers the pre-close gap
      // only. No special branching here.
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