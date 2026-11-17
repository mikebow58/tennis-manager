// app/cancel/[token]/[sessionId]/page.js
//
// Player-facing cancellation confirmation page. Linked from the "Can't make
// it? Cancel your spot" footer in reminder / confirmation emails. Validates
// the player (signup_token + active), confirms they are signed up for the
// session, then renders CancelForm, which posts to /api/cancel.
//
// REVISION (Oct 30, 2026 — split-location day sweep):
// SYMPTOM: the "Session details" box printed `<time> · <venue>`, falling back
// to the literal text "TBD", even on a split-location day, where the venue is
// not known until court assignment is approved/sent.
// ROOT CAUSE: venue was read straight off the session record
// (session.locations.name), a per-session guess made before assignment.
// FIX: venue now comes from getVenueForEmail(sessionId) (lib/day-capacity.js),
// which returns null on split days and on any query error. When null, the box
// shows the time only. The `locations ( name )` join is dropped and the
// '?? "TBD"' fallback is removed on purpose (it would turn a null venue into
// the literal word "TBD").
// NOT CHANGED: willLeaveShort is computed from this session record's active
// players only (the same per-session math as before). On a split day that
// matches how /api/cancel and handlePostCloseCancellation evaluate the
// cancellation, so the warning stays consistent with what the cancel will
// actually do.
//
// BUG FIX (post-beta item #11 follow-up): the player query previously matched
// on signup_token alone, with no active check — the same gap that was fixed
// on the signup page. Adding .eq('active', true) closes it here too: a
// deactivated player's old cancellation link no longer resolves to a valid
// player record.
//
// Post-beta item #9 — player-to-organizer messaging footer link. BUG FIX
// (Sept 2026 — contact page security review): the footer points to the static
// contact-info page (/contact) now, not the retired /contact/${token} form
// route.

import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import CancelForm from './CancelForm'
import { formatTime } from '@/lib/utils'
import { getVenueForEmail } from '@/lib/day-capacity'

export default async function CancelPage({ params }) {
  const { token, sessionId } = await params

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name')
    .eq('signup_token', token)
    .eq('active', true)
    .single()

  if (playerError || !player) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500 mb-4">This cancellation link is invalid.</p>
        <a href="/contact" className="text-sm text-blue-600 hover:underline">
          Need help? Contact us
        </a>
      </div>
    )
  }

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500">Session not found.</p>
      </div>
    )
  }

  const { data: availability } = await supabase
    .from('availability')
    .select('id')
    .eq('session_id', sessionId)
    .eq('player_id', player.id)
    .single()

  if (!availability) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500">You are not signed up for this session.</p>
      </div>
    )
  }

  const { data: activeAvailability } = await supabase
    .from('availability')
    .select('id')
    .eq('session_id', sessionId)
    .in('status', ['confirmed', 'tentative'])

  const playerCount = activeAvailability?.length || 0
  const postCancelCount = Math.max(0, playerCount - 1)
  const willLeaveShort = postCancelCount % 4 !== 0

  // null on split-location days or lookup error — the details box then shows
  // the time only.
  const { locationName } = await getVenueForEmail(sessionId)

  const sessionDate = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Cancel your spot?
        </h1>
        <p className="text-sm text-gray-500">{sessionDate}</p>
      </div>

      <div className="bg-gray-50 rounded-xl p-4 mb-6">
        <div className="text-sm text-gray-600 mb-1">Session details</div>
        <div className="font-medium text-gray-900">
          {formatTime(session.start_time)}{locationName ? ` · ${locationName}` : ''}
        </div>
      </div>

      <CancelForm
        playerId={player.id}
        playerName={player.first_name}
        sessionId={sessionId}
        availabilityId={availability.id}
        playerCount={playerCount ?? 0}
        signupToken={token}
        willLeaveShort={willLeaveShort}
      />

      <div className="mt-8 pt-4 border-t border-gray-100 text-center">
        <a href="/contact" className="text-xs text-gray-400 hover:text-gray-600">
          Having trouble with this page? Let us know
        </a>
      </div>
    </div>
  )
}