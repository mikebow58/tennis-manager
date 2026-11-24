/**
 * ApproveActionsClient
 *
 * Client component: renders the approval action buttons at the bottom of
 * the approve page. Only rendered when week.status === 'pending_approval'.
 *
 * Two actions:
 *   Approve           — POST { action: 'approve' } → week moves to 'approved'
 *                        The weekly-signup-send cron will send signup links
 *                        automatically at the scheduled time.
 *
 *   Approve & send now — POST { action: 'approve_and_send' } → week moves to
 *                        'sent'; signup links go to all active players immediately.
 *                        Used when the organizer acts after the scheduled send
 *                        time has already passed, or wants to send early.
 *                        Now behind a confirmation step (see below).
 *
 * After a successful action, redirects to /weeks so the organizer can see
 * the updated week status on the dashboard.
 *
 * REVISION (Nov 17, 2026 — signup send moved from Friday 9:30am to Wednesday
 * 6:00pm):
 *   1. COPY: the two help texts under the buttons said "Friday morning" / "the
 *      Friday send time". They now read the day/time from
 *      lib/signup-schedule.js (SIGNUP_SEND_LABEL, e.g. "Wednesday at 6:00pm"),
 *      the single code-side source that must match the weekly-signup-send
 *      schedule in vercel.json. That module contains only constants, so
 *      importing it into a client component is safe.
 *   2. CONFIRMATION STEP (closes a gap flagged the same day): "Approve & send
 *      signup links now" used to fire immediately on a single tap, emailing
 *      every active player, even though Automation Logic Section 1 specifies
 *      a confirmation before a manual send ("Send signup requests for the
 *      week of [date]? This will notify all active players and begin the
 *      signup window."). The button now opens an inline confirmation panel
 *      with that text and two buttons ("Yes, send now" / "Cancel"). An inline
 *      panel is used rather than window.confirm because this is a phone-first
 *      admin UI and matches the two-tap confirm pattern already used for
 *      delete in the session row editor. While the panel is open the plain
 *      "Approve" button is disabled so the two paths can't be mixed up. The
 *      weekLabel prop, previously unused, supplies the date in the text.
 *      Plain "Approve" sends nothing to players, so it needs no confirmation.
 *
 * @param {object} props
 * @param {string} props.weekId    - Week UUID
 * @param {string} props.weekLabel - Human-readable week label for confirmation text
 */

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { SIGNUP_SEND_LABEL } from '@/lib/signup-schedule'

export default function ApproveActionsClient({ weekId, weekLabel }) {
  const router = useRouter()

  // Tracks which action is in flight — 'approve' | 'approve_and_send' | null
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)

  // True while the "send now" confirmation panel is showing.
  const [confirmingSend, setConfirmingSend] = useState(false)

  /**
   * Fires the approve API and handles redirect on success.
   * @param {'approve' | 'approve_and_send'} action
   */
  async function handleAction(action) {
    setPending(action)
    setError(null)

    try {
      const res = await fetch(`/api/weeks/${weekId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })

      const data = await res.json()

      if (!res.ok) {
        // Surface the error message from the API — e.g. week already approved
        console.error('[ApproveActionsClient] API error:', data)
        setError(data.error || 'Something went wrong. Please try again.')
        setPending(null)
        return
      }

      console.log('[ApproveActionsClient] Action succeeded:', data)

      // Redirect to weeks list so organizer can see the updated status
      router.push('/weeks')

    } catch (err) {
      console.error('[ApproveActionsClient] Fetch error:', err)
      setError('Network error — please check your connection and try again.')
      setPending(null)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-5 space-y-4">

      <h2 className="text-sm font-semibold text-gray-700">Approve this week</h2>

      {/* Error display */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Approve button — standard path */}
      <div>
        <button
          onClick={() => handleAction('approve')}
          disabled={pending !== null || confirmingSend}
          className="w-full bg-green-600 text-white px-4 py-3 rounded-xl text-sm font-medium
                     hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <p className="text-xs text-gray-400 mt-2">
          Marks the week as approved. Signup links will be sent automatically
          on {SIGNUP_SEND_LABEL}.
        </p>
      </div>

      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-gray-100" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-white px-2 text-xs text-gray-400">or</span>
        </div>
      </div>

      {/* Approve & send now — first tap opens the confirmation panel; only
          "Yes, send now" calls the API. */}
      <div>
        {!confirmingSend ? (
          <>
            <button
              onClick={() => setConfirmingSend(true)}
              disabled={pending !== null}
              className="w-full bg-blue-600 text-white px-4 py-3 rounded-xl text-sm font-medium
                         hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Approve &amp; send signup links now
            </button>
            <p className="text-xs text-gray-400 mt-2">
              Approves the week and immediately sends personalised signup links to
              all active players. Use this if the {SIGNUP_SEND_LABEL} send time has
              already passed, or if you want to send early.
            </p>
          </>
        ) : (
          <div className="border border-blue-200 bg-blue-50 rounded-xl px-4 py-4 space-y-3">
            <p className="text-sm text-blue-900">
              Send signup requests for the week of <strong>{weekLabel}</strong>?
              This will notify all active players and begin the signup window.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleAction('approve_and_send')}
                disabled={pending !== null}
                className="flex-1 bg-blue-600 text-white px-4 py-3 rounded-xl text-sm font-medium
                           hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pending === 'approve_and_send' ? 'Sending…' : 'Yes, send now'}
              </button>
              <button
                onClick={() => setConfirmingSend(false)}
                disabled={pending !== null}
                className="flex-1 bg-white text-gray-700 border border-gray-300 px-4 py-3 rounded-xl
                           text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}