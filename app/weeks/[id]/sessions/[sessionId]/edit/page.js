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
 * NOTE: This page does not currently send notifications to signed-up
 * players when session details change. That notification logic should
 * be added here when built.
 *
 * Tables read: sessions (with locations join), locations
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
    />
  )
}