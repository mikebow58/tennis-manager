import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import Link from 'next/link'
import SendSignupButton from './SendSignupButton'
import { formatTime, isSessionCompleted } from '@/lib/utils'
import { getCapacityTrigger } from '@/lib/session-capacity'

export const dynamic = 'force-dynamic'

// BUG FIX (dev session Aug 25, 2026): two separate issues fixed here.
//
// 1. The old code blended confirmed + tentative + waitlisted into one
//    count and ran a single `count % 4` check against it. A full session
//    with a waitlist (e.g. 24 confirmed + 1 waitlisted = 25) showed as
//    "3 short" — the opposite of reality. Waitlisted players represent
//    over-capacity, not an incomplete court, and must never factor into
//    full/short at all (Phase 2 §5.1 — waitlist_mode is full AND
//    waitlisted > 0, not a variant of short).
//
// 2. Separately, the old "isFull" check was `count % 4 === 0` with no
//    reference to actual capacity — a session with 6 courts available
//    (capacity 24) would show "Full" at just 4 confirmed players. Now
//    uses getCapacityTrigger (courts_available, or anticipated_courts for
//    Mon/Tue) for a real capacity-based Full determination, matching
//    Phase 2 §5.2/5.6.
//
// Pre-close (session.status === 'open') and post-close (status === 'closed')
// short are different concepts per Phase 2 §5.4 and are now computed
// separately: pre-close short is driven by confirmed count against
// capacity; post-close short is driven by tentative count, since Procedure
// 1/2 has already run and settled who's on a complete vs incomplete court.
//
// BUG FIX (dev session Aug 30, 2026): the post-close branch below was
// still deriving isFull/isShort/spotsNeeded from tentativeCount alone.
// That relied on an invariant that no longer holds: confirmedCount was
// always a multiple of 4 until Procedure 2 reran (Procedure 1 guarantees
// this), so tentativeCount % 4 and (confirmedCount + tentativeCount) % 4
// always agreed — the two formulas were indistinguishable in practice.
// The sub-request confirm/decline flow (built July 2026, /subs/respond ->
// claim_sub_request()) breaks that invariant: a responding player is
// INSERTed directly as 'confirmed' (Phase 3 Group 3) without any
// corresponding update to the existing tentative players' status — that
// reclassification only happens when Procedure 2 reruns (session reaches
// full status, or the 6pm deadline). A partial fill-in (e.g. 1 of 2 needed
// spots filled) leaves confirmedCount no longer a multiple of 4 while
// tentativeCount stays frozen in the DB at its Procedure-1 value — so the
// old formula kept reporting the ORIGINAL shortfall instead of the
// remaining one. Now derived from totalSignedUp instead, which stays
// correct regardless of when Procedure 2 next runs. This also matches
// what the session detail page was already doing correctly.
function computeSessionDisplay(session, confirmedCount, tentativeCount, waitlistedCount) {
  if (session.status === 'closed') {
    const totalSignedUp = confirmedCount + tentativeCount
    const isEmpty = totalSignedUp === 0
    const isFull = !isEmpty && totalSignedUp % 4 === 0
    const isShort = !isFull && !isEmpty
    // No extra `|| 4` safety wrap needed here: isShort already excludes
    // the totalSignedUp % 4 === 0 case (that's isFull), so this is always
    // 1, 2, or 3 when isShort is true — never 0.
    const spotsNeeded = isShort ? (4 - (totalSignedUp % 4)) : 0
    return {
      isFull,
      isShort,
      isEmpty,
      spotsNeeded,
      totalSignedUp,
      waitlistedCount,
      emptyLabel: 'No signups',
    }
  }

  // Pre-close (session.status === 'open').
  const { capacityTrigger } = getCapacityTrigger(session)
  const isEmpty = confirmedCount === 0
  const isFull = !isEmpty && confirmedCount >= capacityTrigger
  const hasPartialCourt = confirmedCount % 4 !== 0
  const isShort = !isFull && !isEmpty && hasPartialCourt
  const spotsNeeded = isShort ? (4 - (confirmedCount % 4)) : 0
  return {
    isFull,
    isShort,
    isEmpty,
    spotsNeeded,
    totalSignedUp: confirmedCount,
    waitlistedCount,
    emptyLabel: 'Open',
  }
}

export default async function Dashboard({ searchParams }) {
  const sp = await searchParams
  const viewNext = sp?.view === 'next'

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // V2: weeks.status valid values are pending_approval, approved, sent, closed.
  // The dashboard shows any week that is not yet closed.
  const { data: weeks } = await supabase
    .from('weeks')
    .select('*')
    .in('status', ['pending_approval', 'approved', 'sent'])
    .order('week_start_date', { ascending: true })

  let allSessionsForWeeks = []
  if (weeks && weeks.length > 0) {
    const { data: weekSessions } = await supabase
      .from('sessions')
      .select('week_id, session_date')
      .in('week_id', weeks.map(w => w.id))
    allSessionsForWeeks = weekSessions || []
  }

  // V2: field is week_start_date (not start_date).
  const currentWeek = weeks?.find(w => {
    const start = new Date(w.week_start_date + 'T00:00:00')
    const end = new Date(start)
    end.setDate(end.getDate() + 6)
    if (today < start || today > end) return false
    const weekSessions = allSessionsForWeeks.filter(s => s.week_id === w.id)
    if (weekSessions.length === 0) return true
    return weekSessions.some(s => !isSessionCompleted(s.session_date))
  })

  const futureWeeks = weeks?.filter(w => {
    const start = new Date(w.week_start_date + 'T00:00:00')
    return start > today
  }) || []

  const nextWeek = futureWeeks[0] || null

  let week = null
  if (viewNext && nextWeek) {
    week = nextWeek
  } else if (currentWeek) {
    week = currentWeek
  } else if (nextWeek) {
    week = nextWeek
  } else if (weeks?.length > 0) {
    week = weeks[weeks.length - 1]
  }

  const showingNext = !!(viewNext && nextWeek)
  const canToggle = !!(currentWeek && nextWeek)

  let sessions = []
  let sessionIds = []

  if (week) {
    // V2: join locations so we have the location name for display.
    // courts_available replaces court_count.
    // cancelled_at / cancellation_note / organiser_notes are included via
    // select('*') below.
    const { data } = await supabase
      .from('sessions')
      .select('*, locations(name)')
      .eq('week_id', week.id)
      .order('session_date', { ascending: true })
    sessions = data || []
    sessionIds = sessions.map(s => s.id)
  }

  // Post-beta item #6 — "I'm out this week." Only fetched/shown for the
  // current active signup week (week.status === 'sent'), per organiser
  // decision — a pending/approved/future week has no meaningful opt-outs yet.
  let optedOutPlayers = []
  if (week && week.status === 'sent') {
    const { data: optOuts } = await supabase
      .from('weekly_opt_outs')
      .select('players(first_name, last_name)')
      .eq('week_id', week.id)
    optedOutPlayers = (optOuts || [])
      .map(o => o.players)
      .filter(Boolean)
      .sort((a, b) => a.first_name.localeCompare(b.first_name))
  }

  // Three separate tallies instead of one blended count — see bug fix
  // note above computeSessionDisplay.
  const confirmedCounts = {}
  const tentativeCounts = {}
  const waitlistedCounts = {}
  const playersWithSignup = new Set()
  let cancellationCount = 0

  if (sessionIds.length > 0) {
    // BUG FIX (dev session Sep 1, 2026): added cancellation_reason to the
    // select. A tentative player whose court never fills is auto-released
    // by daily-8pm-backstop (or manually by the organiser via the
    // court-assignment review screen) with status = 'cancelled' — same as
    // a real cancellation. cancellation_reason distinguishes them
    // ('court_not_filled' vs 'player_initiated' / 'admin_cancelled'), so
    // the count below can exclude the former. See migration
    // 20260901000000_add_cancellation_reason.sql.
    const { data: availability } = await supabase
      .from('availability')
      .select('session_id, player_id, status, cancellation_reason')
      .in('session_id', sessionIds)

    if (availability) {
      availability.forEach(({ session_id, player_id, status, cancellation_reason }) => {
        if (status === 'cancelled') {
          // A court that never filled is not a cancellation — the
          // player didn't back out, the court just came up short.
          // NULL cancellation_reason (legacy/unhandled write paths)
          // still counts, matching pre-fix behaviour as a safe default.
          if (cancellation_reason !== 'court_not_filled') {
            cancellationCount++
          }
          return
        }
        playersWithSignup.add(player_id)
        if (status === 'confirmed') {
          confirmedCounts[session_id] = (confirmedCounts[session_id] || 0) + 1
        } else if (status === 'tentative') {
          tentativeCounts[session_id] = (tentativeCounts[session_id] || 0) + 1
        } else if (status === 'waitlisted') {
          waitlistedCounts[session_id] = (waitlistedCounts[session_id] || 0) + 1
        }
      })
    }
  }

  const { data: allPlayers } = await supabase
    .from('players')
    .select('id')
    .eq('active', true)

  const totalPlayers = allPlayers?.length || 0

  // Cancelled sessions are excluded from the "courts short" metric — a
  // cancelled session isn't short, it's cancelled. Uses the same corrected
  // computeSessionDisplay logic as the day cards below, rather than a
  // separate ad hoc calculation.
  const shortCount = sessions.filter(s => {
    if (s.cancelled_at) return false
    if (isSessionCompleted(s.session_date)) return false
    const info = computeSessionDisplay(
      s,
      confirmedCounts[s.id] || 0,
      tentativeCounts[s.id] || 0,
      waitlistedCounts[s.id] || 0
    )
    return info.isShort || info.isEmpty
  }).length

  const weekLabel = week
    ? new Date(week.week_start_date).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
      })
    : null

  const sentLabel = week?.signup_sent_at
    ? new Date(week.signup_sent_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Denver'
      })
    : null

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      {!week ? (
        <div className="text-center py-16">
          <p className="text-gray-500 mb-4">No open weeks found.</p>
          <Link
            href="/weeks/new"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm"
          >
            Create a week
          </Link>
        </div>
      ) : (
        <>
          <div className="bg-[#0f172a] px-4 md:px-8 pt-5 pb-4">
            <div className="max-w-5xl mx-auto">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold text-white">Dev Dashboard</h1>
                  <p className="text-xs text-slate-300 mt-0.5">Week of {weekLabel}</p>
                </div>
                {canToggle && (
                  <Link
                    href={showingNext ? '/' : '/?view=next'}
                    className="text-xs text-slate-300 hover:text-white border border-slate-600 rounded-lg px-3 py-1.5 mt-1"
                  >
                    {showingNext ? '← Current week' : 'Next week →'}
                  </Link>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Active players</div>
                  <div className="text-2xl font-medium text-slate-900">{totalPlayers}</div>
                </div>
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Responded</div>
                  <div className="text-2xl font-medium text-green-700">{playersWithSignup.size}</div>
                </div>
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Courts short</div>
                  <div className={`text-2xl font-medium ${shortCount > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
                    {shortCount}
                  </div>
                </div>
                <div className="bg-slate-200 rounded-xl p-3">
                  <div className="text-xs text-slate-500 mb-1">Cancellations</div>
                  <div className={`text-2xl font-medium ${cancellationCount > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
                    {cancellationCount}
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-3">
                {week.signup_sent_at ? (
                  <div className="flex justify-between items-center max-w-xs">
                    <span className="text-xs font-medium text-emerald-400">Signup requests sent</span>
                    <span className="text-xs text-slate-300">{sentLabel}</span>
                  </div>
                ) : (
                  <SendSignupButton weekId={week.id} signupSentAt={week.signup_sent_at} />
                )}
              </div>
            </div>
          </div>

          <div className="px-4 md:px-8 pt-4 pb-6 max-w-5xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {sessions.map((session) => {
                const confirmedCount = confirmedCounts[session.id] || 0
                const tentativeCount = tentativeCounts[session.id] || 0
                const waitlistedCount = waitlistedCounts[session.id] || 0
                const completed = isSessionCompleted(session.session_date)

                const info = computeSessionDisplay(
                  session,
                  confirmedCount,
                  tentativeCount,
                  waitlistedCount
                )
                const { isFull, isShort, isEmpty, spotsNeeded, totalSignedUp, emptyLabel } = info

                const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC'
                })

                // V2: courts_available replaces court_count.
                const courtsAvailable = session.courts_available ?? '?'
                // V2: location name from join.
                const locationName = session.locations?.name ?? '—'

                // Organizer-only note (organiser_notes column) — internal
                // context for the organizer, never sent to players.
                const organizerNote = session.organiser_notes?.trim() || null

                // ------------------------------------------------------
                // Cancelled state — checked BEFORE the completed check,
                // since a cancelled session could be in the future or the
                // past relative to today. Renders a distinct card instead
                // of the normal open/short/full states.
                // ------------------------------------------------------
                if (session.cancelled_at) {
                  return (
                    <div
                      key={session.id}
                      className="block rounded-xl p-4 bg-red-50 border border-red-200"
                    >
                      <div className="text-sm font-medium mb-1 text-red-900">{dateLabel}</div>
                      <div className="text-xs text-red-400 mb-3">
                        {formatTime(session.start_time)} · {locationName}
                      </div>
                      {session.cancellation_note && (
                        <div className="text-xs text-red-700 italic mb-3 border-t border-red-200 pt-2">
                          "{session.cancellation_note}"
                        </div>
                      )}
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-red-400">
                          {totalSignedUp} player{totalSignedUp !== 1 ? 's' : ''}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-600 text-white">
                          Cancelled
                        </span>
                      </div>
                    </div>
                  )
                }

                if (completed) {
                  return (
                    <div
                      key={session.id}
                      className="block rounded-xl p-4 bg-gray-100 border border-gray-200 opacity-60"
                    >
                      <div className="text-sm font-medium mb-1 text-gray-400">{dateLabel}</div>
                      <div className="text-xs text-gray-400 mb-3">
                        {formatTime(session.start_time)} · {locationName}
                      </div>
                      {organizerNote && (
                        <div className="text-xs text-gray-400 italic mb-3 border-t border-gray-200 pt-2">
                          {organizerNote}
                        </div>
                      )}
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-400">
                          {totalSignedUp} player{totalSignedUp !== 1 ? 's' : ''}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-200 text-gray-500">
                          Completed
                        </span>
                      </div>
                    </div>
                  )
                }

                return (
                  <Link
                    key={session.id}
                    href={`/weeks/${week.id}/sessions/${session.id}`}
                    className={`block rounded-xl p-4 transition-opacity hover:opacity-90 ${
                      isFull
                        ? 'bg-green-50 border border-green-200'
                        : isShort
                        ? 'bg-amber-50 border border-amber-200'
                        : 'bg-white border border-gray-200'
                    }`}
                  >
                    <div className={`text-sm font-medium mb-1 ${
                      isFull
                        ? 'text-green-900'
                        : isShort
                        ? 'text-amber-900'
                        : 'text-gray-900'
                    }`}>
                      {dateLabel}
                    </div>
                    <div className="text-xs text-gray-400 mb-3">
                      {formatTime(session.start_time)} · {locationName}
                    </div>
                    {organizerNote && (
                      <div className="text-xs text-gray-500 italic mb-3 border-t border-gray-100 pt-2">
                        {organizerNote}
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-400">
                        {isEmpty
                          ? `${courtsAvailable} ${courtsAvailable === 1 ? 'court' : 'courts'}`
                          : `${totalSignedUp} player${totalSignedUp !== 1 ? 's' : ''} · ${courtsAvailable} ${courtsAvailable === 1 ? 'court' : 'courts'}`}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        isFull
                          ? 'bg-green-600 text-white'
                          : isShort
                          ? 'bg-amber-500 text-white'
                          : 'bg-gray-500 text-white'
                      }`}>
                        {isFull ? 'Full' : isEmpty ? emptyLabel : isShort ? `${spotsNeeded} short` : 'Open'}
                      </span>
                    </div>
                    {/* Design decision (Aug 25, 2026 session): Full + waitlist
                        shown as small supplementary text under the badge,
                        rather than replacing the badge or adding a second one. */}
                    {isFull && waitlistedCount > 0 && (
                      <div className="text-xs text-blue-500 mt-1 text-right">
                        +{waitlistedCount} waitlisted
                      </div>
                    )}
                  </Link>
                )
              })}
            </div>

            {optedOutPlayers.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
                <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">
                  Players Out This Week
                </div>
                <div className="space-y-1">
                  {optedOutPlayers.map((p, i) => (
                    <div key={i} className="text-xs text-gray-700">
                      {p.first_name} {p.last_name}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">
                Reminders
              </div>
              <div className="space-y-2">
                {sessions.map((session) => {
                  const completed = isSessionCompleted(session.session_date)
                  const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
                    weekday: 'long',
                    timeZone: 'UTC'
                  })
                  return (
                    <div key={session.id} className="flex justify-between items-center">
                      <span className={`text-xs ${
                        session.cancelled_at || completed ? 'text-gray-300' : 'text-gray-700'
                      }`}>
                        {dateLabel}
                      </span>
                      <span className={`text-xs ${
                        session.cancelled_at
                          ? 'text-red-400'
                          : completed
                          ? 'text-gray-300'
                          : session.reminder_sent_at
                          ? 'text-green-600'
                          : 'text-gray-400'
                      }`}>
                        {session.cancelled_at
                          ? 'Cancelled'
                          : completed
                          ? 'Completed'
                          : session.reminder_sent_at
                          ? `Sent · ${new Date(session.reminder_sent_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                              timeZone: 'America/Denver'
                            })}`
                          : 'Not yet sent'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}