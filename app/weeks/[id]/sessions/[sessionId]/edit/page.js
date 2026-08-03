/**
 * /weeks/[id]/sessions/[sessionId]/edit
 *
 * Session edit page. Available post-approval for organiser edits to
 * start time, location, courts available, format, and notes.
 *
 * Date is not editable — changing a session date after players have
 * signed up would create data integrity issues.
 *
 * Status is not editable — managed by the automated workflow only.
 *
 * DELETE ELIGIBILITY (NEW this revision — organiser's simplified session
 * cancellation design, "Option D"): once the parent week's signup email has
 * gone out (weeks.signup_sent_at is set) AND at least one player has signed
 * up for THIS session, deleting the session is no longer allowed — a locked-
 * in session must be cancelled instead (see the new "Cancel this session"
 * action on the session detail page, app/weeks/[id]/sessions/[sessionId]/
 * page.js), which notifies confirmed players rather than silently removing
 * their signup. canDelete is computed here and passed down; the Delete
 * button itself is hidden by EditSessionClient when canDelete is false.
 *
 * "At least one player signed up" is checked as a plain row count on
 * availability for this session, regardless of status (confirmed,
 * tentative, waitlisted, cancelled, declined all count) — the point is
 * simply whether any player has ever interacted with this session's signup,
 * not their current status.
 *
 * NOTE: This page does not currently send notifications to signed-up
 * players when session details change. That notification logic should
 * be added here when built.
 *
 * Tables read: sessions (with locations join), locations, weeks, availability
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import EditSessionClient from './EditSessionClient'

export const dynamic = 'force-dynamic'

export default async function EditSessionPage({ params }) {
  const { id, sessionId } = await params

  // Fetch session with location join for current values
  const { data: session, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .select('*, locations(id, name)')
    .eq('id', sessionId)
    .single()

  if (sessionError || !session) {
    console.error('[edit session] Session fetch error:', sessionError)
    return (
      <div className="min-h-screen bg-[#f1efe9] flex items-center justify-center">
        <p className="text-sm text-gray-500">Session not found.</p>
      </div>
    )
  }

  // Fetch all active locations for the dropdown
  const { data: locations, error: locationsError } = await supabaseAdmin
    .from('locations')
    .select('id, name')
    .eq('active', true)
    .order('name', { ascending: true })

  if (locationsError) {
    console.error('[edit session] Locations fetch error:', locationsError)
  }

  // Fetch the parent week's signup_sent_at — one half of the canDelete check.
  const { data: week, error: weekError } = await supabaseAdmin
    .from('weeks')
    .select('signup_sent_at')
    .eq('id', session.week_id)
    .single()

  if (weekError) {
    console.error('[edit session] Week fetch error:', weekError)
  }

  // Count any availability rows for this session, regardless of status —
  // presence of even one row means at least one player has signed up.
  // head: true means we get only the count, not the rows themselves.
  const { count: playerCount, error: countError } = await supabaseAdmin
    .from('availability')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)

  if (countError) {
    console.error('[edit session] Player count fetch error:', countError)
  }

  // Delete is disabled once BOTH conditions hold: the week's signup email
  // has gone out AND at least one player has signed up for this session.
  // If either condition is false, delete remains available (e.g. week not
  // yet sent, or sent but nobody has signed up for this specific day yet).
  const canDelete = !(week?.signup_sent_at && (playerCount ?? 0) > 0)

  const sessionDateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <EditSessionClient
      session={session}
      locations={locations || []}
      sessionDateLabel={sessionDateLabel}
      weekId={id}
      canDelete={canDelete}
    />
  )
}