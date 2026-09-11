// app/admin/sub-requests/[sessionId]/page.js
//
// New admin-only detail page (Sept 2026 session — waitlist-expiry
// redesign, dashboard sub-request visibility). Linked from the "Sub
// request active — sent to N players" indicator on the dashboard day
// card (app/page.js). Shows every sub_requests row for a session — active
// ones first, most recent overall — with its full recipient list and each
// recipient's stored response.
//
// No new query capability was needed for this: sub_request_recipients.
// response already stores 'confirmed' / 'declined' / 'no_response'
// directly (Automation Logic Section 17.1), so this page is purely a
// read-only view over existing data.
//
// This is an admin-only page. It is intentionally NOT added to
// isPublicRoute in either lib/supabase-middleware.js or
// SignOutButton.js — those allowlists are for unauthenticated
// player-facing routes only. This page is protected by middleware.js's
// default auth requirement, same as every other /admin/* page.

import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import { formatTime } from '@/lib/utils'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const REQUEST_TYPE_LABELS = {
  first_call: 'First Call',
  all_available: 'All Available',
  waitlist: 'Waitlist',
  late_cancellation: 'Late Cancellation',
}

export default async function SubRequestDetailPage({ params }) {
  const { sessionId } = await params

  const { data: session } = await supabase
    .from('sessions')
    .select('session_date, start_time, locations ( name )')
    .eq('id', sessionId)
    .single()

  const { data: subRequests } = await supabase
    .from('sub_requests')
    .select(`
      id,
      request_type,
      status,
      sent_at,
      sub_request_recipients (
        response,
        players ( first_name, last_name )
      )
    `)
    .eq('session_id', sessionId)
    .order('sent_at', { ascending: false })

  const sessionDateLabel = session?.session_date
    ? new Date(session.session_date + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
      })
    : 'Unknown date'

  const locationName = session?.locations?.name ?? 'TBD'
  const startTimeLabel = session?.start_time ? formatTime(session.start_time) : 'TBD'

  function responseLabel(response) {
    if (response === 'confirmed') return { text: 'Confirmed', className: 'text-green-600' }
    if (response === 'declined') return { text: 'Declined', className: 'text-red-500' }
    return { text: 'No response', className: 'text-gray-400' }
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-xl font-semibold text-white">Sub Requests</h1>
          <p className="text-xs text-slate-300 mt-0.5">
            {sessionDateLabel} · {startTimeLabel} · {locationName}
          </p>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-3xl mx-auto space-y-4">
        {(!subRequests || subRequests.length === 0) && (
          <p className="text-sm text-gray-500">No sub requests have been sent for this session.</p>
        )}

        {(subRequests || []).map((sr) => {
          const recipients = sr.sub_request_recipients || []
          return (
            <section key={sr.id} className="bg-white border border-gray-200 rounded-xl px-6 py-5">
              <div className="flex justify-between items-center mb-1">
                <h2 className="text-sm font-semibold text-gray-800">
                  {REQUEST_TYPE_LABELS[sr.request_type] ?? sr.request_type}
                </h2>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  sr.status === 'active' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {sr.status === 'active' ? 'Active' : 'Closed'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mb-4">
                Sent {new Date(sr.sent_at).toLocaleString('en-US', {
                  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  timeZone: 'America/Denver',
                })}
                {' · '}
                {recipients.length} player{recipients.length !== 1 ? 's' : ''} contacted
              </p>

              {recipients.length === 0 ? (
                <p className="text-xs text-gray-400">No recipients recorded.</p>
              ) : (
                <div className="space-y-1.5">
                  {recipients.map((rec, i) => {
                    const label = responseLabel(rec.response)
                    return (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-gray-700">
                          {rec.players?.first_name} {rec.players?.last_name}
                        </span>
                        <span className={`text-xs font-medium ${label.className}`}>
                          {label.text}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}

        <Link href="/" className="text-sm text-blue-600 hover:underline inline-block">
          ← Back to dashboard
        </Link>
      </div>
    </div>
  )
}