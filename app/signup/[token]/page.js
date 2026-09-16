// BUG FIX (dev session Aug 25, 2026): the currentWeek query previously used
// .eq('status', 'sent').single(), which assumes at most one week is ever in
// 'sent' status at a time. That assumption is false by design — a new
// week's signup send goes out Friday while the current week's sessions are
// still running through Saturday, meaning two weeks are legitimately
// 'sent' simultaneously for a multi-day window every single week. .single()
// throws (PGRST116) whenever more than one row matches, which silently
// dropped currentWeek to null and broke this entire page.
//
// Fix: order by week_start_date descending and take the most recent match
// via .maybeSingle() (not .single()) so the newest sent week is always the
// one used, and a genuine zero-match case fails gracefully instead of
// throwing. See Phase 3 Group 6 (Signup Link Security and Session
// Visibility) for the underlying rule this page enforces.
//
// THIS REVISION (Sept 2026 session — Player page build): this route is now
// permanently the "Player page." Per organiser decision (state handoff,
// Sept 11 2026), no separate /portal route is being built — the player's
// existing, non-rotating signup_token URL does double duty year-round.
// New behaviour: whenever there is nothing open for this player to sign up
// for (openSessions.length === 0 — covers both "no week is sent right now"
// and "a week is sent but every session in it has already closed to new
// signups," which is actually the more common week-to-week case), the page
// now looks up the player's nearest upcoming confirmed/tentative session
// and shows a status summary instead of a dead-end generic message. Falls
// back to the original generic "nothing open" message (Project Summary
// §8.2 / post-beta item "Empty signup page state") if no upcoming session
// is found either.
//
// NOTE: this bypasses SignupForm entirely for the empty-state case, the
// same way the existing opted-out branch below already does — SignupForm's
// own internals for sessions=[] were not reviewed as part of this change
// (file wasn't available this session). Worth a quick check that nothing
// inside SignupForm.js was relying on being rendered with an empty
// sessions array.
//
// NOTE: the nested-relation query below (sessions joined to availability
// via `availability!inner(...)`, filtered by player_id/status on the
// embedded resource) has not been directly tested against the dev database
// as of this revision — flagging for verification in the next test pass,
// per this project's practice of confirming schema assumptions before
// trusting them.

import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import SignupForm from './SignupForm'

export default async function SignupPage({ params }) {
  const { token } = await params

  // BUG FIX (post-beta item #11): .eq('active', true) added so a
  // deactivated player's old signup link no longer resolves to a valid
  // player record. See item #11 discussion for the full history.
  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id, first_name, last_name, signup_token')
    .eq('signup_token', token)
    .eq('active', true)
    .single()

  if (playerError || !player) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-gray-500 mb-4">This signup link is invalid or has expired.</p>
        <a href="/contact" className="text-sm text-blue-600 hover:underline">
          Need help? Contact us
        </a>
      </div>
    )
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().split('T')[0]

  const { data: currentWeek } = await supabase
    .from('weeks')
    .select('id')
    .eq('status', 'sent')
    .order('week_start_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Post-beta item #6 — "I'm out this week." Whole-week, non-rescindable
  // opt-out. If this player already opted out of the current signup week,
  // short-circuit straight to a static message — no day-picker, no undo.
  // See app/api/signup/[token]/opt-out/route.js for the write path.
  let optedOut = false
  if (currentWeek) {
    const { data: optOutRow } = await supabase
      .from('weekly_opt_outs')
      .select('id')
      .eq('player_id', player.id)
      .eq('week_id', currentWeek.id)
      .maybeSingle()
    optedOut = !!optOutRow
  }

  if (optedOut) {
    return (
      <div className="max-w-md mx-auto p-6 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
        <p className="text-sm text-gray-500 mt-6">
          You're marked as out this week. We'll see you next week!
        </p>
        {/* BUG FIX (Sept 2026 — contact page security review): contact
            form/route retired; link now points to the static contact-info
            page rather than the old /contact/${token} dynamic route, which
            no longer exists. */}
        <div className="mt-8 pt-4 border-t border-gray-100 text-center">
          <a href="/contact" className="text-xs text-gray-400 hover:text-gray-600">
            Having trouble with this page? Let us know
          </a>
        </div>
      </div>
    )
  }

  const openSessions = []

  if (currentWeek) {
    const { data: sessions, error: sessionsError } = await supabase
      .from('sessions')
      .select('*')
      .eq('week_id', currentWeek.id)
      .is('reminder_sent_at', null)
      .is('cancelled_at', null)
      .gte('session_date', todayStr)
      .order('session_date', { ascending: true })

    if (sessionsError) {
      console.error(sessionsError)
      return <div className="p-8">Error loading sessions.</div>
    }

    if (sessions) openSessions.push(...sessions)
  }

  // ---------------------------------------------------------------------
  // NEW (Sept 2026 — Player page): nothing currently open for this player
  // to act on. Before falling back to a dead-end generic message, check
  // whether they have an upcoming confirmed/tentative spot worth showing.
  // Returned early, before the signedUpSessionIds query below, since it's
  // not needed on this path.
  // ---------------------------------------------------------------------
  if (openSessions.length === 0) {
    const { data: upcomingSessions, error: upcomingError } = await supabase
      .from('sessions')
      .select(`
        session_date,
        start_time,
        locations ( name ),
        availability!inner ( status )
      `)
      .gte('session_date', todayStr)
      .is('cancelled_at', null)
      .eq('availability.player_id', player.id)
      .in('availability.status', ['confirmed', 'tentative'])
      .order('session_date', { ascending: true })
      .limit(1)

    if (upcomingError) {
      // Non-fatal — the status summary is a nicety, not core functionality.
      // Log and fall through to the generic message rather than breaking
      // the whole page over it.
      console.error('Player page upcoming-status query error:', upcomingError)
    }

    const upcoming = upcomingSessions && upcomingSessions.length > 0
      ? upcomingSessions[0]
      : null

    if (upcoming) {
      const upcomingStatus = upcoming.availability?.[0]?.status
      // Parse as local midnight (not UTC) to avoid the date shifting back
      // a day in negative-offset timezones when session_date is a bare
      // date string like "2026-09-17".
      const dateLabel = new Date(`${upcoming.session_date}T00:00:00`).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      })
      const locationName = upcoming.locations?.name || 'the usual spot'

      return (
        <div className="max-w-md mx-auto p-6">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-gray-900 mb-1">
              Hi, {player.first_name}!
            </h1>
          </div>

          {upcomingStatus === 'confirmed' ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm text-green-800">
                You're confirmed for <strong>{dateLabel}</strong> at {locationName}.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-800">
                You're tentatively on the roster for <strong>{dateLabel}</strong> at{' '}
                {locationName}. We're still working on completing your court and
                will let you know as soon as it's settled — usually by early
                evening the day before.
              </p>
            </div>
          )}

          <p className="text-sm text-gray-500 mt-6">
            No new signup window is open right now. You'll receive an email
            when the next one opens.
          </p>

          <div className="mt-8 pt-4 border-t border-gray-100 text-center">
            <a href="/contact" className="text-xs text-gray-400 hover:text-gray-600">
              Having trouble with this page? Let us know
            </a>
          </div>
        </div>
      )
    }

    // No upcoming confirmed/tentative session either — original generic
    // message, rendered directly (see file header note on the SignupForm
    // bypass).
    return (
      <div className="max-w-md mx-auto p-6 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
        <p className="text-sm text-gray-500 mt-6">
          No sessions are currently open for signup. You'll receive an email
          when the next signup window opens.
        </p>
        <div className="mt-8 pt-4 border-t border-gray-100 text-center">
          <a href="/contact" className="text-xs text-gray-400 hover:text-gray-600">
            Having trouble with this page? Let us know
          </a>
        </div>
      </div>
    )
  }

  const { data: existing } = await supabase
    .from('availability')
    .select('session_id')
    .eq('player_id', player.id)
    .neq('status', 'cancelled')

  const signedUpSessionIds = existing ? existing.map(e => e.session_id) : []

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
      </div>

      <SignupForm
        player={player}
        sessions={openSessions}
        signedUpSessionIds={signedUpSessionIds}
      />

      {/* Post-beta item #9 — player-to-organizer messaging footer link.
          BUG FIX (Sept 2026 — contact page security review): points to
          the static contact-info page now, not the retired /contact/${token}
          form route. */}
      <div className="mt-8 pt-4 border-t border-gray-100 text-center">
        <a href="/contact" className="text-xs text-gray-400 hover:text-gray-600">
          Having trouble with this page? Let us know
        </a>
      </div>
    </div>
  )
}