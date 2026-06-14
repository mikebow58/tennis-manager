/**
 * app/admin/court-assignment/[sessionId]/page.js
 *
 * Court Assignment Review Page — organiser-facing screen for reviewing,
 * adjusting, and approving Procedure 2 court assignments before player
 * notifications are sent.
 *
 * SERVER COMPONENT: fetches all data for the day and passes it to the
 * client component as props. No sensitive keys exposed to the browser.
 *
 * URL: /admin/court-assignment/[sessionId]
 * sessionId can be ANY session from the target day — sibling sessions
 * (multi-location days) are resolved automatically via week_id + session_date.
 *
 * AUTH: protected by middleware — organiser must be logged in.
 * Uses supabase-server.js (cookie-based session) to verify auth, then
 * supabaseAdmin for the actual data queries (service role, bypasses RLS).
 *
 * DATA LOADED:
 *   - All sibling sessions for the day (resolved via week_id + session_date)
 *   - court_assignments records for all sibling sessions
 *   - availability records (confirmed + tentative) for all sibling sessions
 *   - Player details (name, skill) for display
 *   - courts_available per session (to constrain court number dropdowns)
 *   - Location details (name, courts_available) per session
 *
 * References:
 *   Phase 2 Section 4.5 (Procedure 2 — Final Court Assignment)
 *   Automation Logic Section 8.2 (court assignment notification paths)
 */

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import CourtAssignmentClient from './CourtAssignmentClient'

export default async function CourtAssignmentPage({ params }) {
  // ---------------------------------------------------------------------------
  // 1. Resolve params — Next.js 15 async params pattern.
  // ---------------------------------------------------------------------------
  const resolvedParams = params && typeof params.then === 'function'
    ? await params
    : params

  // Extract sessionId with case-insensitive fallback (Next.js 15 dynamic
  // segment casing can vary — same defensive pattern as the approval route).
  const sessionId = resolvedParams.sessionID || resolvedParams.sessionId || resolvedParams.id

  // ---------------------------------------------------------------------------
  // 2. Verify organiser is authenticated via cookie-based session.
  //    supabase-server.js uses anon key bound to the user's cookie — this is
  //    the correct client for admin pages that need to gate on auth status.
  // ---------------------------------------------------------------------------
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    // Not logged in — redirect to login. Middleware should catch this first,
    // but this is a belt-and-suspenders guard.
    redirect('/login')
  }

  // ---------------------------------------------------------------------------
  // 3. Fetch the anchor session plus its parent week status.
  //    We use supabaseAdmin here (service role) for all data queries —
  //    the auth check above is sufficient to gate access.
  // ---------------------------------------------------------------------------
  const { data: anchorSession, error: anchorError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      week_id,
      session_date,
      start_time,
      courts_available,
      status,
      cancelled_at,
      court_assignment_sent_at,
      locations ( id, name, total_courts ),
      weeks!inner ( status )
    `)
    .eq('id', sessionId)
    .single()

  if (anchorError || !anchorSession) {
    // Session not found — return a simple error message rather than crashing.
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h2>Session not found</h2>
        <p>Session ID {sessionId} could not be found. It may have been deleted.</p>
      </div>
    )
  }

  // Guard: only allow access if the parent week is in sent status.
  // Court assignment only applies to active (sent) weeks.
  if (anchorSession.weeks.status !== 'sent') {
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h2>Court assignment unavailable</h2>
        <p>Court assignment is only available for weeks in sent status. This week is currently <strong>{anchorSession.weeks.status}</strong>.</p>
      </div>
    )
  }

  // Guard: session must be closed (reminder sent) for Procedure 2 to be relevant.
  if (anchorSession.status !== 'closed') {
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h2>Court assignment not yet available</h2>
        <p>Court assignment is only available after the session reminder has been sent. This session is currently <strong>{anchorSession.status}</strong>.</p>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // 4. Resolve all sibling sessions for this day.
  //    Multi-location days have multiple sessions sharing week_id + session_date.
  //    We treat them as one unified day for the purpose of this screen.
  // ---------------------------------------------------------------------------
  const { data: daySessions, error: dayError } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      start_time,
      courts_available,
      location_id,
      status,
      cancelled_at,
      court_assignment_sent_at,
      locations ( id, name, total_courts )
    `)
    .eq('week_id', anchorSession.week_id)
    .eq('session_date', anchorSession.session_date)
    .eq('status', 'closed')
    .is('cancelled_at', null)

  if (dayError || !daySessions?.length) {
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h2>Unable to load sessions</h2>
        <p>Could not load sessions for this day. Please try again.</p>
      </div>
    )
  }

  const sessionIds = daySessions.map(s => s.id)

  // ---------------------------------------------------------------------------
  // 5. Fetch court_assignments for all sessions on this day.
  //    These are the Procedure 2 results (court letters, tentative status).
  //    court_number may be null — organiser assigns on this screen.
  // ---------------------------------------------------------------------------
  const { data: courtAssignments, error: caError } = await supabaseAdmin
    .from('court_assignments')
    .select(`
      id,
      session_id,
      player_id,
      location_id,
      court_letter,
      court_number,
      assignment_status,
      players ( id, first_name, last_name, skill_admin, skill_self )
    `)
    .in('session_id', sessionIds)
    .order('court_letter', { ascending: true })

  if (caError) {
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h2>Unable to load court assignments</h2>
        <p>Error: {caError.message}</p>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // 6. Fetch availability records for confirmed and tentative players.
  //    We need availability.id for the assignments payload, and status to
  //    distinguish confirmed from tentative players.
  // ---------------------------------------------------------------------------
  const { data: availabilityRecords, error: availError } = await supabaseAdmin
    .from('availability')
    .select(`
      id,
      session_id,
      player_id,
      status,
      court_letter,
      court_assignment_status
    `)
    .in('session_id', sessionIds)
    .in('status', ['confirmed', 'tentative'])

  if (availError) {
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h2>Unable to load availability records</h2>
        <p>Error: {availError.message}</p>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // 7. Build a human-readable date label for display.
  //    Parse as UTC noon to avoid timezone rollover issues.
  // ---------------------------------------------------------------------------
  const sessionDateLabel = new Date(anchorSession.session_date + 'T12:00:00Z')
    .toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    })

  // ---------------------------------------------------------------------------
  // 8. Determine if this day has already been approved/sent.
  //    If court_assignment_sent_at is set on any session, the day is finalised.
  //    Show a read-only confirmation rather than the edit UI.
  // ---------------------------------------------------------------------------
  const alreadyFinalised = daySessions.some(s => s.court_assignment_sent_at != null)

  // ---------------------------------------------------------------------------
  // 9. Pass all data to the client component as plain serialisable props.
  //    No Supabase clients, no server-only imports cross the server/client boundary.
  // ---------------------------------------------------------------------------
  return (
    <CourtAssignmentClient
      anchorSessionId={sessionId}
      weekId={anchorSession.week_id}
      sessionDate={anchorSession.session_date}
      sessionDateLabel={sessionDateLabel}
      daySessions={daySessions}
      courtAssignments={courtAssignments ?? []}
      availabilityRecords={availabilityRecords ?? []}
      alreadyFinalised={alreadyFinalised}
    />
  )
}
