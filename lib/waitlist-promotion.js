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
 *   (and app/api/cancel/route.js, 'open' branch)
 *
 * Organiser notification is conditional — see notifyOrganiser param. When
 * the organiser themselves caused the cancellation, no alert is sent (they
 * already see the result in the admin UI). When a player self-cancels,
 * the organiser is notified since they had no other visibility into it.
 *
 * ======================================================================
 * THIS REVISION (Oct 30, 2026 — split-location days)
 * ======================================================================
 * SYMPTOM 1: the "you're in!" email to a promoted player, and the waitlist
 * promotion notice to the organizer, both named a venue ("at Memorial Park")
 * for a day on which the organizer had created two sessions at different
 * locations with the same start time. No venue had been decided.
 *
 * ROOT CAUSE 1: this file read locations.name from whichever session record
 * the promoted player's availability row happened to be attached to. On a
 * split day that is an arbitrary session (with day-level signup, the first in
 * fill order), so the venue named was a guess presented as fact. Which venue
 * any individual player plays at is not known until court assignment has been
 * approved.
 *
 * FIX 1: the venue now comes from getVenueForEmail() (lib/day-capacity.js),
 * which returns null when more than one live session exists that day. A null
 * locationName is passed through to both email functions, which omit the
 * "at <venue>" wording and (player email) say the court and location will
 * follow once courts are assigned. Single-location days are unchanged.
 * Requires the matching edits to lib/email.js — see sendWaitlistSpotOpened
 * ToConfirmed and sendWaitlistPromotionNotice there; without them a null
 * venue would print "at null".
 *
 * SYMPTOM 2: the organizer notice gave the cancelled player's FULL name but
 * only the promoted player's FIRST name.
 *
 * ROOT CAUSE 2: the waitlist query selected only players.first_name, and the
 * notice was built from that.
 *
 * FIX 2: players.last_name is now selected, and promotedPlayerName is
 * "First Last" (trimmed if last_name is missing). The player-facing email
 * still greets by first name only. The function's return value keeps
 * playerName as the first name (as before, in case a caller uses it) and adds
 * playerFullName.
 *
 * LOGGING: this revision logs availability ids rather than player names.
 *
 * DEPENDENCIES: imports lib/day-capacity.js (new import), lib/email.js
 * (two functions, edited in the same pass), lib/session-capacity.js,
 * lib/admin-settings.js. No schema change.
 *
 * ----------------------------------------------------------------------
 * PRIOR HISTORY (retained)
 * ----------------------------------------------------------------------
 * (Sept 2026 session — Player page build): portalUrl renamed to
 * playerPageUrl and its value corrected from `/portal/${token}` (a route
 * that was never built and, per organiser decision — state handoff Sept 11
 * 2026 — never will be) to `/signup/${token}`, the permanent Player page.
 *
 * References:
 *   Original Automation Logic conversation — pre-close waitlist promotion:
 *     "If at least one player is in the waitlist: the first player in the
 *     waitlist is moved to the active list and the session remains Full."
 *   Phase 2 Section 5 — Session Roster Condition (lib/session-capacity.js)
 *   Phase 2 Section 7.2 — waitlisted → confirmed transition
 *   Phase 2 Section 7.5 — Waitlisted player removal is a record deletion
 *   Automation Logic Section 7 — players sign up for the day, not a venue
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getSessionRosterCondition } from '@/lib/session-capacity'
import { getVenueForEmail } from '@/lib/day-capacity'
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
 * @param {string} params.cancelledPlayerName - FULL name, for the organiser
 *   notice copy
 * @param {boolean} params.notifyOrganiser - false when the organiser caused
 *   the cancellation themselves (admin manual removal); true for player
 *   self-removal.
 * @returns {Promise<{ promoted: boolean, playerName?: string,
 *   playerFullName?: string }>} playerName is the promoted player's first
 *   name (unchanged from before); playerFullName is "First Last".
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
  // last_name is selected (new) so the organiser notice can show a full name.
  // ------------------------------------------------------------------
  const { data: waitlistRow, error: waitlistError } = await supabaseAdmin
    .from('availability')
    .select(`
      id,
      player_id,
      created_at,
      players ( first_name, last_name, email, signup_token )
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

  // First name for the player-facing greeting; full name for the organiser.
  const playerName = waitlistRow.players?.first_name ?? 'Player'
  const playerFullName = [waitlistRow.players?.first_name, waitlistRow.players?.last_name]
    .filter(Boolean)
    .join(' ') || 'Player'

  console.log(
    `[waitlist-promotion] Session ${sessionId} — promoted availability ${waitlistRow.id} from waitlisted to confirmed.`
  )

  // ------------------------------------------------------------------
  // Fetch session details for email copy. The date comes from the session
  // itself; the venue comes from getVenueForEmail(), which returns null on a
  // split-location day (see header, FIX 1).
  // ------------------------------------------------------------------
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('session_date, start_time')
    .eq('id', sessionId)
    .single()

  const sessionDateLabel = session?.session_date
    ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })
    : 'this session'

  // null = do NOT name a venue (split day, or the lookup failed).
  const { locationName } = await getVenueForEmail(sessionId)

  // ------------------------------------------------------------------
  // Notify the promoted player — always.
  // ------------------------------------------------------------------
  if (waitlistRow.players?.email) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
    await sendWaitlistSpotOpenedToConfirmed({
      playerFirstName: waitlistRow.players.first_name,
      playerEmail: waitlistRow.players.email,
      sessionDateLabel,
      locationName, // may be null — email.js omits the venue in that case
      playerPageUrl: `${baseUrl}/signup/${waitlistRow.players.signup_token}`,
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
        promotedPlayerName: playerFullName, // full name, to match cancelledPlayerName
        sessionDateLabel,
        locationName, // may be null — email.js omits the venue in that case
      }).catch((err) =>
        console.error(`[waitlist-promotion] Failed to send organiser notice:`, err)
      )
    }
  }

  return { promoted: true, playerName, playerFullName }
}