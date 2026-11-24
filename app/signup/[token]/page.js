// REVISION (Nov 17, 2026 — signup send moved from Friday 9:30am to Wednesday
// 6:00pm):
// SYMPTOM (anticipated, not yet seen live): the Player page only showed the
// player's "You're confirmed for <day>" status card when NOTHING was open for
// signup (openSessions.length === 0). Under the old Friday send that overlap
// lasted about two days (Friday through the Saturday session). With the send
// on Wednesday evening, a week is open for signup from Wednesday evening
// until its sessions' reminders go out — so for roughly four days a player
// who is confirmed for this week's Thursday/Friday/Saturday session saw only
// next week's signup form, with no sign that they are playing this week.
// ROOT CAUSE: the status card and the signup form were mutually exclusive
// branches; two weeks are legitimately 'sent' at the same time (see the Aug
// 25 history below) but the page could only show one of the two.
// FIX: the nearest-upcoming-session lookup was extracted into
// loadUpcomingStatus() and an UpcomingStatusCard component, and the card now
// also renders above the signup form whenever that upcoming session belongs to
// a DIFFERENT week than the one being signed up for. If the nearest session
// is in the signup week itself, the form's own pre-selected days already show
// it, so no card is added. The empty-state branch behaves exactly as before.
//
// ALSO IN THIS REVISION:
//   - The "I'm out" short-circuit said "You're marked as out this week. We'll
//     see you next week!". That wording was written when the signup week was
//     a week away; with a Wednesday send, "this week" reads as the CURRENT
//     week. It now names the week: "You're marked as out for the week of
//     <date>. We'll see you next time!" (currentWeek now selects
//     week_start_date for the label).
//   - Comment in the Aug 25 history updated to say the send is now Wednesday.
//   NOT CHANGED: SignupForm.js (not reviewed — it may say "this week" in its
//   own copy), and the opt-out write route app/api/signup/[token]/opt-out,
//   which presumably targets the newest sent week the same way this page
//   chooses currentWeek; both should be checked.
//
// ---------------------------------------------------------------------
// PRIOR REVISION (Oct 30, 2026 — day-level signup):
// SYMPTOM: on a split-location day (e.g. Wednesday at two venues) the
// signup form listed one row per session record, so the same day appeared
// twice with identical start times and no way to tell the rows apart (the
// freeform sessions.location column the form displayed is empty for sessions
// created from default_sessions, which use location_id). Which row a player
// clicked also decided whether they were waitlisted.
// ROOT CAUSE: the page passed raw session rows to SignupForm, which rendered
// one row per row. Players are supposed to sign up for the DAY; venue
// assignment is a court-assignment concern (Automation Logic Section 7).
// FIX: sessions for the sent week are grouped by session_date into "days".
// Each day carries every open session id for that date, a representative
// primarySessionId (what the form sends to /api/availability, which resolves
// the real session server-side — see lib/day-capacity.js), and its distinct
// start times. SignupForm now renders one row per day and shows no location.
//
// ALSO IN THAT REVISION:
//   - The player's existing signups are now passed as signedUpDays, a map of
//     day key (session_date) -> 'confirmed' | 'waitlisted'. This closes the
//     "KNOWN GAP" documented in the previous SignupForm: a player waitlisted
//     on an earlier visit used to see confirmed styling on return.
//   - The existing-signups query now selects only confirmed/tentative/
//     waitlisted rows (previously everything except 'cancelled', which would
//     also have included 'declined' rows). No practical difference pre-close.
//   - Player-page status card (the empty-state branch): the location name is
//     omitted when the player's upcoming session is on a split-location day,
//     since which venue they play at is not decided until court assignment.
//     The card still shows the location on single-location days.
//   - Sessions are now selected with an explicit column list instead of '*'.
//
// DEPENDENCIES: renders app/signup/[token]/SignupForm.js (props changed:
// sessions/signedUpSessionIds replaced by days/signedUpDays — both files must
// be deployed together). Reads players, weeks, weekly_opt_outs, sessions,
// availability. No schema change; no new route (no allowlist changes).
//
// ---------------------------------------------------------------------
// PRIOR HISTORY (retained)
// ---------------------------------------------------------------------
// BUG FIX (dev session Aug 25, 2026): the currentWeek query previously used
// .eq('status', 'sent').single(), which assumes at most one week is ever in
// 'sent' status at a time. That assumption is false by design — a new
// week's signup send goes out while the current week's sessions are
// still running (originally Friday; as of Nov 17, 2026 Wednesday evening),
// meaning two weeks are legitimately 'sent' simultaneously for a multi-day
// window every single week. .single() throws (PGRST116) whenever more than
// one row matches, which silently dropped currentWeek to null and broke this
// entire page.
//
// Fix: order by week_start_date descending and take the most recent match
// via .maybeSingle() (not .single()) so the newest sent week is always the
// one used, and a genuine zero-match case fails gracefully instead of
// throwing. See Phase 3 Group 6 (Signup Link Security and Session
// Visibility) for the underlying rule this page enforces.
//
// (Sept 2026 — Player page build): this route is permanently the "Player
// page." Per organizer decision (state handoff, Sept 11 2026), no separate
// /portal route is being built — the player's existing, non-rotating
// signup_token URL does double duty year-round. Whenever there is nothing
// open for this player to sign up for (openSessions.length === 0 — covers
// both "no week is sent right now" and "a week is sent but every session in
// it has already closed to new signups"), the page looks up the player's
// nearest upcoming confirmed/tentative session and shows a status summary
// instead of a dead-end generic message. Falls back to the original generic
// "nothing open" message (Project Summary §8.2 / post-beta item "Empty
// signup page state") if no upcoming session is found either.
//
// NOTE: this bypasses SignupForm entirely for the empty-state case, the
// same way the existing opted-out branch below already does.
//
// NOTE: the nested-relation query below (sessions joined to availability
// via `availability!inner(...)`, filtered by player_id/status on the
// embedded resource) was flagged as not directly tested against the dev
// database when written; it has since been exercised during cron testing.

import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import SignupForm from './SignupForm'

/**
 * Finds the player's nearest upcoming confirmed/tentative session and
 * prepares everything the status card needs. Extracted (Nov 17, 2026) so the
 * same lookup can serve both the empty-state branch and the "signup open AND
 * playing this week" case.
 *
 * Returns null if the player has no upcoming confirmed/tentative session.
 * Query failures are non-fatal — the status card is a nicety, not core
 * functionality — so they are logged and treated as "nothing found".
 *
 * @param {number|string} playerId
 * @param {string} todayStr - 'YYYY-MM-DD'
 * @returns {Promise<null | {
 *   weekId: number|string, status: string, dateLabel: string,
 *   locationSuffix: string
 * }>}
 */
async function loadUpcomingStatus(playerId, todayStr) {
  const { data: upcomingSessions, error: upcomingError } = await supabase
    .from('sessions')
    .select(`
      week_id,
      session_date,
      start_time,
      locations ( name ),
      availability!inner ( status )
    `)
    .gte('session_date', todayStr)
    .is('cancelled_at', null)
    .eq('availability.player_id', playerId)
    .in('availability.status', ['confirmed', 'tentative'])
    .order('session_date', { ascending: true })
    .limit(1)

  if (upcomingError) {
    console.error('Player page upcoming-status query error:', upcomingError)
    return null
  }

  const upcoming = upcomingSessions && upcomingSessions.length > 0
    ? upcomingSessions[0]
    : null

  if (!upcoming) return null

  const status = upcoming.availability?.[0]?.status

  // Parse as local midnight (not UTC) to avoid the date shifting back
  // a day in negative-offset timezones when session_date is a bare
  // date string like "2026-09-17".
  const dateLabel = new Date(`${upcoming.session_date}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })

  // (Oct 30, 2026) On a split-location day the player's row is attached to
  // ONE session record, but which venue they actually play at is not decided
  // until court assignment. Count the day's sessions; if there is more than
  // one, leave the location out of the message.
  const { count: sessionsThatDay, error: countError } = await supabase
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('week_id', upcoming.week_id)
    .eq('session_date', upcoming.session_date)
    .is('cancelled_at', null)

  if (countError) {
    // Non-fatal: on error, treat as a single-location day (previous behavior).
    console.error('Player page split-day check error:', countError)
  }

  const isSplitDay = (sessionsThatDay ?? 1) > 1
  const locationName = upcoming.locations?.name || 'the usual spot'
  // Empty string on split days so the sentence reads cleanly without it.
  const locationSuffix = isSplitDay ? '' : ` at ${locationName}`

  return { weekId: upcoming.week_id, status, dateLabel, locationSuffix }
}

/**
 * The green "You're confirmed" / amber "tentatively on the roster" card.
 * Shared by the empty-state branch and the signup-open branch.
 */
function UpcomingStatusCard({ upcomingStatus }) {
  const { status, dateLabel, locationSuffix } = upcomingStatus

  if (status === 'confirmed') {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4">
        <p className="text-sm text-green-800">
          You're confirmed for <strong>{dateLabel}</strong>{locationSuffix}.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-800">
        You're tentatively on the roster for <strong>{dateLabel}</strong>{locationSuffix}. We're still working on completing your court and
        will let you know as soon as it's settled — usually by early
        evening the day before.
      </p>
    </div>
  )
}

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

  // week_start_date added Nov 17, 2026 for the opted-out message below.
  const { data: currentWeek } = await supabase
    .from('weeks')
    .select('id, week_start_date')
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
    // Nov 17, 2026: names the week instead of saying "this week" — see the
    // file header. Falls back to generic wording if the date is unavailable.
    const optedOutWeekLabel = currentWeek?.week_start_date
      ? new Date(currentWeek.week_start_date + 'T12:00:00Z').toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        })
      : null

    return (
      <div className="max-w-md mx-auto p-6 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
        <p className="text-sm text-gray-500 mt-6">
          {optedOutWeekLabel
            ? `You're marked as out for the week of ${optedOutWeekLabel}. We'll see you next time!`
            : "You're marked as out for this signup week. We'll see you next time!"}
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
    // Open for signup = reminder not yet sent, not cancelled, not in the past.
    // (Same definition lib/day-capacity.js uses to find sibling sessions.)
    const { data: sessions, error: sessionsError } = await supabase
      .from('sessions')
      .select('id, session_date, start_time, courts_available')
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
  // (Sept 2026 — Player page): nothing currently open for this player
  // to act on. Before falling back to a dead-end generic message, check
  // whether they have an upcoming confirmed/tentative spot worth showing.
  // Returned early, before the signed-up-days query below, since it's
  // not needed on this path.
  // ---------------------------------------------------------------------
  if (openSessions.length === 0) {
    const upcomingStatus = await loadUpcomingStatus(player.id, todayStr)

    if (upcomingStatus) {
      return (
        <div className="max-w-md mx-auto p-6">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-gray-900 mb-1">
              Hi, {player.first_name}!
            </h1>
          </div>

          <UpcomingStatusCard upcomingStatus={upcomingStatus} />

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

  // ---------------------------------------------------------------------
  // NEW (Nov 17, 2026): signup is open AND the player may also be playing
  // earlier in the current week (two 'sent' weeks overlap from the Wednesday
  // evening send until the last session of the old week). Show their
  // nearest upcoming status above the form, but only if that session is in a
  // different week — if it is in the signup week itself, the form already
  // shows it as a pre-selected day.
  // ---------------------------------------------------------------------
  const upcomingStatusRaw = await loadUpcomingStatus(player.id, todayStr)
  const upcomingStatusForOtherWeek =
    upcomingStatusRaw && String(upcomingStatusRaw.weekId) !== String(currentWeek.id)
      ? upcomingStatusRaw
      : null

  // ---------------------------------------------------------------------
  // (Oct 30, 2026) Group open sessions into days. openSessions is
  // already ordered by session_date, so Map insertion order is date order.
  // Within a day, sessions are ordered largest courts_available first, then
  // lowest id — the same fill order lib/day-capacity.js uses server-side.
  // ---------------------------------------------------------------------
  const sessionsByDate = new Map()
  for (const session of openSessions) {
    if (!sessionsByDate.has(session.session_date)) {
      sessionsByDate.set(session.session_date, [])
    }
    sessionsByDate.get(session.session_date).push(session)
  }

  const days = [...sessionsByDate.entries()].map(([sessionDate, daySessions]) => {
    const ordered = daySessions.slice().sort((a, b) => {
      const courtsDiff = (b.courts_available ?? 0) - (a.courts_available ?? 0)
      return courtsDiff !== 0 ? courtsDiff : a.id - b.id
    })
    return {
      key: sessionDate,                              // unique per day
      session_date: sessionDate,
      sessionIds: ordered.map((s) => s.id),          // every open session that day
      primarySessionId: ordered[0].id,               // what the form POSTs
      // Distinct start times that day, sorted ("08:00:00" sorts correctly as text).
      startTimes: [...new Set(ordered.map((s) => s.start_time).filter(Boolean))].sort(),
    }
  })

  // ---------------------------------------------------------------------
  // The player's current signups, reduced to one status per day.
  // ---------------------------------------------------------------------
  const { data: existing, error: existingError } = await supabase
    .from('availability')
    .select('session_id, status')
    .eq('player_id', player.id)
    .in('status', ['confirmed', 'tentative', 'waitlisted'])

  if (existingError) {
    // Non-fatal: worst case the form renders with nothing pre-selected.
    console.error('Signup page existing-availability query error:', existingError)
  }

  const statusBySessionId = new Map((existing ?? []).map((e) => [e.session_id, e.status]))
  const signedUpDays = {}
  for (const day of days) {
    for (const sessionId of day.sessionIds) {
      const status = statusBySessionId.get(sessionId)
      if (status) {
        // tentative only exists post-close; treat anything not waitlisted as confirmed here.
        signedUpDays[day.key] = status === 'waitlisted' ? 'waitlisted' : 'confirmed'
        break
      }
    }
  }

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi, {player.first_name}!
        </h1>
      </div>

      {upcomingStatusForOtherWeek && (
        <div className="mb-6">
          <UpcomingStatusCard upcomingStatus={upcomingStatusForOtherWeek} />
        </div>
      )}

      <SignupForm
        player={player}
        days={days}
        signedUpDays={signedUpDays}
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