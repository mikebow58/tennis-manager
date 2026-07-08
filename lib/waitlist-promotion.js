/**
 * lib/waitlist-promotion.js
 *
 * Pre-close single-slot waitlist promotion. Fires when a CONFIRMED player's
 * pre-close removal (session.status = 'open') drops the session out of Full
 * status while at least one waitlisted player exists. The FIFO-first
 * waitlisted player (earliest availability.created_at) is promoted to
 * confirmed, restoring the session to Full — a clean swap, not a net loss.
 *
 * Does NOT apply when a WAITLISTED player removes themselves — that's a
 * plain record deletion per Phase 2 Section 7.5, no promotion triggered,
 * since removing a waitlisted player doesn't free up a confirmed spot.
 *
 * Called from both pre-close removal routes:
 *   - app/api/availability/route.js (player self-removal)
 *   - app/api/admin/availability/route.js (organiser manual removal, 'open'
 *     branch only)
 *
 * Organiser notification is conditional — see notifyOrganiser param. When
 * the organiser themselves caused the cancellation, no alert is sent (they
 * already see the result in the admin UI). When a player self-cancels,
 * the organiser is notified since they had no other visibility into it.
 *
 * References:
 *   Original Automation Logic conversation — pre-close waitlist promotion:
 *     "If at least one player is in the waitlist: the first player in the
 *     waitlist is moved to the active list and the session remains Full."
 *   Phase 2 Section 5 — Session Roster Condition (lib/session-capacity.js)
 *   Phase 2 Section 7.2 — waitlisted → confirmed transition
 *   Phase 2 Section 7.5 — Waitlisted player removal is a record deletion
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getSessionRosterCondition } from '@/lib/session-capacity'
import { getAdminEmail } from '@/lib/admin-settings'
import {
  sendWaitlistSpotOpenedToConfirmed,
  sendWaitlistPromotionNotice,
} from '@/lib/email'

/**
 * Checks whether an open spot now exists with a waitlist behind it, and if
 * so, promotes the FIFO-first waitlisted player to confirmed. No-op if
 * there's no waitlist, or if the session isn't actually below capacity
 * (defensive — should not occur given callers only invoke this after a
 * confirmed player's removal, but checked explicitly rather than assumed).
 *
 * @param {object} params
 * @param {string|number} params.sessionId
 * @param {string} params.cancelledPlayerName - for the organiser notice copy
 * @param {boolean} params.notifyOrganiser - false when the organiser caused
 *   the cancellation themselves (admin manual removal); true for player
 *   self-removal.
 * @returns {Promise<{ promoted: boolean, playerName?: string }>}
 */
export async function promoteFromWaitlistIfOpenSpot({
  sessionId,
  cancelledPlayerName,
  notifyOrganiser,
}) {
  const condition = await getSessionRosterCondition({ sessionId })

  if (!condition) {
    console.error(
      `[waitlist-promotion] Could not fetch roster condition for session ${sessionId} — skipping promotion check.`
    )
    return { promoted: false }
  }

  if (condition.waitlistedCount === 0) {
    console.log(`[waitlist-promotion] Session ${sessionId} — no waitlisted players. Nothing to promote.`)
    return { promoted: false }
  }

  if (condition.confirmedCount >= condition.capacityTrigger) {
    console.log(
      `[waitlist-promotion] Session ${sessionId} — still at or above capacity ` +
      `(confirmed=${condition.confirmedCount}, trigger=${condition.capacityTrigger}). No open spot. Skipping.`
    )
    return { promoted: false }
  }

  // ------------------------------------------------------------------
  // Fetch the FIFO-first waitlisted player for this session.
  // ------------------------------------------------------------------
  const { data: waitlistRow, error: waitlistError } = await supabaseAdmin
    .from('availability')
    .select(`
      id,
      player_id,
      created_at,
      players ( first_name, email, signup_token )
    `)
    .eq('session_id', sessionId)
    .eq('status', 'waitlisted')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (waitlistError || !waitlistRow) {
    console.error(
      `[waitlist-promotion] Session ${sessionId} — failed to fetch FIFO waitlisted player:`,
      waitlistError?.message
    )
    return { promoted: false }
  }

  // ------------------------------------------------------------------
  // Promote: waitlisted → confirmed.
  // ------------------------------------------------------------------
  const { error: promoteError } = await supabaseAdmin
    .from('availability')
    .update({ status: 'confirmed' })
    .eq('id', waitlistRow.id)

  if (promoteError) {
    console.error(
      `[waitlist-promotion] Session ${sessionId} — failed to promote availability ${waitlistRow.id}:`,
      promoteError.message
    )
    return { promoted: false }
  }

  const playerName = waitlistRow.players?.first_name ?? 'Player'
  console.log(
    `[waitlist-promotion] Session ${sessionId} — promoted ${playerName} (availability ${waitlistRow.id}) from waitlisted to confirmed.`
  )

  // ------------------------------------------------------------------
  // Fetch session details for email copy (date, location).
  // ------------------------------------------------------------------
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('session_date, start_time, locations ( name )')
    .eq('id', sessionId)
    .single()

  const sessionDateLabel = session?.session_date
    ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })
    : 'this session'
  const locationName = session?.locations?.name ?? 'TBD'

  // ------------------------------------------------------------------
  // Notify the promoted player — always.
  // ------------------------------------------------------------------
  if (waitlistRow.players?.email) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
    await sendWaitlistSpotOpenedToConfirmed({
      playerFirstName: waitlistRow.players.first_name,
      playerEmail: waitlistRow.players.email,
      sessionDateLabel,
      locationName,
      portalUrl: `${baseUrl}/portal/${waitlistRow.players.signup_token}`,
    }).catch((err) =>
      console.error(`[waitlist-promotion] Failed to send promotion email to promoted player:`, err)
    )
  }

  // ------------------------------------------------------------------
  // Notify the organiser — only when they didn't cause this themselves.
  // ------------------------------------------------------------------
  if (notifyOrganiser) {
    const adminEmail = await getAdminEmail()
    if (adminEmail) {
      await sendWaitlistPromotionNotice({
        adminEmail,
        cancelledPlayerName,
        promotedPlayerName: playerName,
        sessionDateLabel,
        locationName,
      }).catch((err) =>
        console.error(`[waitlist-promotion] Failed to send organiser notice:`, err)
      )
    }
  }

  return { promoted: true, playerName }
}