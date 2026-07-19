// app/subs/respond/page.js
//
// Player-facing landing page for a sub-request confirm/decline link.
// GET only — this page never writes to the database. That's deliberate:
// email clients and corporate scanners (Outlook Safe Links, Gmail's
// link-scanning proxy) pre-fetch links found in emails before a person
// ever opens them. If this page mutated on load, a scanner's prefetch
// would silently claim or decline a spot on the player's behalf. All
// mutation happens via the POST route (/api/subs/respond) triggered by an
// explicit button tap, and this page always re-renders from fresh DB
// state afterward (POST/redirect/GET pattern) — so the same query that
// renders the "respond now" buttons also correctly renders the
// "you're confirmed" result once a response has been recorded.

import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * Formats a session_date (YYYY-MM-DD) and start_time (HH:MM:SS) into
 * player-facing display strings. Matches the formatting convention used
 * elsewhere in this codebase (UTC-anchored to avoid off-by-one date bugs).
 */
function formatSessionDisplay(sessionDate, startTime) {
  const dateLabel = sessionDate
    ? new Date(sessionDate + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })
    : 'Unknown date'

  const timeLabel = startTime
    ? new Date(`1970-01-01T${startTime}Z`).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
      })
    : null

  return { dateLabel, timeLabel }
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb', padding: '16px' }}>
      <div style={{ maxWidth: '480px', width: '100%', background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '32px', textAlign: 'center' }}>
        {children}
      </div>
    </div>
  )
}

export default async function SubResponsePage({ searchParams }) {
  // Next.js 15: searchParams is async.
  const params = await searchParams
  const token = params?.token
  const subId = params?.sub_id ? Number(params.sub_id) : null

  if (!token || !subId) {
    return (
      <Shell>
        <h1 style={{ color: '#dc2626' }}>Invalid link</h1>
        <p style={{ color: '#444' }}>This link is missing information. Please check your email and try again.</p>
      </Shell>
    )
  }

  // 1. Identify the player. No mutation.
  const { data: player } = await supabaseAdmin
    .from('players')
    .select('id, first_name')
    .eq('signup_token', token)
    .maybeSingle()

  if (!player) {
    return (
      <Shell>
        <h1 style={{ color: '#dc2626' }}>Link not recognized</h1>
        <p style={{ color: '#444' }}>We couldn't match this link to a player record.</p>
      </Shell>
    )
  }

  // 2. Load the sub request, its session, and this player's recipient row.
  const { data: subRequest } = await supabaseAdmin
    .from('sub_requests')
    .select(`
      id,
      status,
      sessions (
        id,
        session_date,
        start_time,
        cancelled_at,
        location,
        locations ( name )
      )
    `)
    .eq('id', subId)
    .maybeSingle()

  if (!subRequest) {
    return (
      <Shell>
        <h1 style={{ color: '#dc2626' }}>Request not found</h1>
        <p style={{ color: '#444' }}>This sub request no longer exists.</p>
      </Shell>
    )
  }

  const { data: recipient } = await supabaseAdmin
    .from('sub_request_recipients')
    .select('id, response')
    .eq('sub_request_id', subId)
    .eq('player_id', player.id)
    .maybeSingle()

  if (!recipient) {
    return (
      <Shell>
        <h1 style={{ color: '#dc2626' }}>Not available to you</h1>
        <p style={{ color: '#444' }}>This request wasn't sent to you.</p>
      </Shell>
    )
  }

  const session = subRequest.sessions
  const locationName = session?.locations?.name ?? session?.location ?? 'TBD'
  const { dateLabel, timeLabel } = formatSessionDisplay(session?.session_date, session?.start_time)

  // 3. Terminal states, checked in priority order.
  if (session?.cancelled_at) {
    return (
      <Shell>
        <h1 style={{ color: '#111' }}>Session cancelled</h1>
        <p style={{ color: '#444' }}>The {dateLabel} session was cancelled by the organiser. No action needed.</p>
      </Shell>
    )
  }

  if (recipient.response === 'confirmed') {
    return (
      <Shell>
        <h1 style={{ color: '#16a34a' }}>You're confirmed!</h1>
        <p style={{ color: '#444' }}>You're on the roster for <strong>{dateLabel}</strong>{timeLabel ? ` at ${timeLabel}` : ''} at {locationName}. See you there!</p>
      </Shell>
    )
  }

  if (recipient.response === 'declined') {
    return (
      <Shell>
        <h1 style={{ color: '#444' }}>Response recorded</h1>
        <p style={{ color: '#444' }}>Thanks for letting us know — you've declined this spot for {dateLabel}.</p>
      </Shell>
    )
  }

  if (recipient.response === 'stale' || subRequest.status === 'closed') {
    return (
      <Shell>
        <h1 style={{ color: '#b45309' }}>Spot already filled</h1>
        <p style={{ color: '#444' }}>Another player claimed this spot before you responded. Keep an eye out for future openings!</p>
      </Shell>
    )
  }

  // 4. Open state — show details and both action buttons.
  return (
    <Shell>
      <h1 style={{ color: '#111', marginBottom: '8px' }}>Hi {player.first_name},</h1>
      <p style={{ color: '#444', lineHeight: 1.6, marginBottom: '24px' }}>
        A spot is open for <strong>{dateLabel}</strong>{timeLabel ? ` at ${timeLabel}` : ''} at {locationName}. Want it?
      </p>

      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
        <form method="POST" action="/api/subs/respond">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="sub_id" value={subId} />
          <input type="hidden" name="action" value="confirm" />
          <button type="submit" style={{ background: '#16a34a', color: 'white', padding: '12px 24px', borderRadius: '8px', border: 'none', fontWeight: 500, fontSize: '16px' }}>
            Yes, I'll play
          </button>
        </form>

        <form method="POST" action="/api/subs/respond">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="sub_id" value={subId} />
          <input type="hidden" name="action" value="decline" />
          <button type="submit" style={{ background: '#f3f4f6', color: '#444', padding: '12px 24px', borderRadius: '8px', border: '1px solid #ddd', fontWeight: 500, fontSize: '16px' }}>
            No thanks
          </button>
        </form>
      </div>
    </Shell>
  )
}