/**
 * /admin/weeks/[id]/approve
 *
 * The week approval page. Linked from the organizer notification emails sent
 * by monday-week-creation (new week ready), approval-reminder (Tuesday),
 * urgent-approval-reminder (Wednesday morning), and the weekly-signup-send
 * skip notification (Wednesday evening, if the week was still unapproved).
 *
 * What the organizer can do here:
 *   1. Review the auto-created sessions for the week
 *   2. Edit any session inline (start time, courts available, notes)
 *      before approving — changes are saved immediately per session
 *   3. Approve the week (→ approved status; the weekly-signup-send cron sends
 *      signup links automatically at the scheduled time — see
 *      lib/signup-schedule.js)
 *   4. Approve and send now (→ sent status, signup links go immediately)
 *      This option is shown when the scheduled send time has already passed
 *      OR when the organizer wants to send early.
 *
 * State machine transitions handled (Phase 2 Section 3.2):
 *   pending_approval → approved       (Approve button)
 *   pending_approval → sent           (Approve & send now button)
 *
 * If week is already approved or sent, the page renders a read-only view
 * with a status notice rather than the approval form.
 *
 * REVISION (Nov 17, 2026 — signup send moved from Friday 9:30am to Wednesday
 * 6:00pm):
 *   1. The "week approved" notice said links go out "automatically on Friday
 *      morning". It now reads the day/time from lib/signup-schedule.js
 *      (SIGNUP_SEND_LABEL, e.g. "Wednesday at 6:00pm"), the single code-side
 *      source that must match the weekly-signup-send schedule in vercel.json.
 *   2. Header comments updated: the cron routes were renamed and the Friday
 *      references removed.
 *   3. BUG FIX: the sessions select did not include `organiser_notes`, but
 *      the session row editor (ApproveWeekClient) initializes its internal
 *      "Organizer note" field from session.organiser_notes and always sends
 *      that field back on Save. With the column missing from the select, the
 *      field always started empty, so saving ANY edit to a session would
 *      overwrite an existing internal organizer note with null (assuming the
 *      PATCH route writes the field it is given). The column is now selected.
 *
 * Tables read: weeks, sessions, locations
 * Auth: server component uses supabase-server.js (organizer session required)
 */

import { createClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import SessionListClient from './SessionListClient'
import ApproveActionsClient from './ApproveActionsClient'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { SIGNUP_SEND_LABEL } from '@/lib/signup-schedule'

export const dynamic = 'force-dynamic'

export default async function ApproveWeekPage({ params }) {
  const { id: weekId } = await params

  // Auth check — uses server client which reads the organizer's session cookie
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Data queries — use supabaseAdmin (service role) consistent with all other
  // pages in the codebase. The server client's anon key is subject to RLS
  // which may block reads even with a valid session on some query paths.
  const { data: week, error: weekError } = await supabaseAdmin
    .from('weeks')
    .select('id, week_start_date, status, approved_at, signup_sent_at')
    .eq('id', weekId)
    .single()

  if (weekError || !week) {
    console.error('[approve page] Week not found:', weekError)
    return (
      <div className="min-h-screen bg-[#f1efe9] flex items-center justify-center">
        <p className="text-sm text-gray-500">Week not found.</p>
      </div>
    )
  }

  // ── Fetch sessions for this week ───────────────────────────────────────
  // organiser_notes added Nov 17, 2026 — see file header, fix 3.
  const { data: sessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select('id, session_date, start_time, courts_available, notes, organiser_notes, status, location_id')
    .eq('week_id', weekId)
    .order('session_date', { ascending: true })

  // Fetch active locations for the location dropdown on the session edit form
  const { data: locations, error: locationsError } = await supabaseAdmin
    .from('locations')
    .select('id, name')
    .eq('active', true)
    .order('name', { ascending: true })

  if (locationsError) {
    console.error('[approve page] Locations fetch error:', locationsError)
    // Non-fatal — page can still render; location dropdown will be empty
  }

  if (sessionsError) {
    console.error('[approve page] Sessions fetch error:', sessionsError)
    return (
      <div className="min-h-screen bg-[#f1efe9] flex items-center justify-center">
        <p className="text-sm text-gray-500">Error loading sessions.</p>
      </div>
    )
  }

  // ── Build human-readable week label ────────────────────────────────────
  const weekLabel = new Date(week.week_start_date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

  // ── Determine page mode based on current week status ──────────────────
  // Only pending_approval weeks show the approval action buttons.
  // approved, sent, and closed weeks render a read-only status notice.
  const isActionable = week.status === 'pending_approval'
  const isApproved   = week.status === 'approved'
  const isSent       = week.status === 'sent'
  const isClosed     = week.status === 'closed'

  return (
    <div className="min-h-screen bg-[#f1efe9]">

      {/* ── Header ── */}
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-3xl mx-auto">

          <a href="/weeks"
            className="text-xs text-slate-400 hover:text-slate-200 mb-2 inline-block"
          >
            ← Weeks
          </a>
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-xl font-semibold text-white">
                Week of {weekLabel}
              </h1>
              <p className="text-xs text-slate-300 mt-0.5">
                Status:{' '}
                <span className={
                  week.status === 'pending_approval' ? 'text-amber-400' :
                  week.status === 'approved'         ? 'text-green-400' :
                  week.status === 'sent'             ? 'text-blue-400'  :
                  'text-slate-400'
                }>
                  {week.status.replace(/_/g, ' ')}
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Page body ── */}
      <div className="px-4 md:px-8 py-6 max-w-3xl mx-auto space-y-4">

        {/* ── Already-actioned notice (non-pending weeks) ── */}
        {!isActionable && (
          <div className={`rounded-xl px-4 py-4 text-sm border ${
            isSent
              ? 'bg-blue-50 border-blue-200 text-blue-800'
              : isApproved
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-gray-50 border-gray-200 text-gray-600'
          }`}>
            {isSent && (
              <>
                <strong>Signup links have been sent.</strong> Players have
                received their personalised signup links for this week.
                {week.signup_sent_at && (
                  <span className="block mt-1 text-xs opacity-75">
                    Sent{' '}
                    {new Date(week.signup_sent_at).toLocaleString('en-US', {
                      timeZone: 'America/Denver',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              </>
            )}
            {isApproved && (
              <>
                <strong>Week approved.</strong> Signup links will be sent
                automatically on {SIGNUP_SEND_LABEL}.
                {week.approved_at && (
                  <span className="block mt-1 text-xs opacity-75">
                    Approved{' '}
                    {new Date(week.approved_at).toLocaleString('en-US', {
                      timeZone: 'America/Denver',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              </>
            )}
            {isClosed && (
              <><strong>This week is closed.</strong> All sessions have passed.</>
            )}
          </div>
        )}

        {/* Sessions list — rendered by SessionListClient so delete
            can remove rows from state without a full page reload */}
        <SessionListClient
          sessions={sessions ?? []}
          locations={locations ?? []}
          isEditable={isActionable}
          weekId={weekId}
        />

        {/* ── Approval action buttons — pending_approval weeks only ── */}
        {isActionable && (
          <ApproveActionsClient weekId={weekId} weekLabel={weekLabel} />
        )}

      </div>
    </div>
  )
}