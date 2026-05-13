/**
 * ApproveActionsClient
 *
 * Client component: renders the approval action buttons at the bottom of
 * the approve page. Only rendered when week.status === 'pending_approval'.
 *
 * Two actions:
 *   Approve           — POST { action: 'approve' } → week moves to 'approved'
 *                        Friday cron will send signup links automatically.
 *
 *   Approve & send now — POST { action: 'approve_and_send' } → week moves to
 *                        'sent'; signup links go to all active players immediately.
 *                        Used when the organiser acts after the Friday send time
 *                        has already passed, or wants to send early.
 *
 * After a successful action, redirects to /weeks so the organiser can see
 * the updated week status on the dashboard.
 *
 * @param {object} props
 * @param {string} props.weekId    - Week UUID
 * @param {string} props.weekLabel - Human-readable week label for confirmation text
 */

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ApproveActionsClient({ weekId, weekLabel }) {
  const router = useRouter()

  // Tracks which action is in flight — 'approve' | 'approve_and_send' | null
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)

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

      // Redirect to weeks list so organiser can see the updated status
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
          disabled={pending !== null}
          className="w-full bg-green-600 text-white px-4 py-3 rounded-xl text-sm font-medium
                     hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <p className="text-xs text-gray-400 mt-2">
          Marks the week as approved. Signup links will be sent automatically
          on Friday morning.
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

      {/* Approve & send now button */}
      <div>
        <button
          onClick={() => handleAction('approve_and_send')}
          disabled={pending !== null}
          className="w-full bg-blue-600 text-white px-4 py-3 rounded-xl text-sm font-medium
                     hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending === 'approve_and_send'
            ? 'Sending…'
            : 'Approve & send signup links now'}
        </button>
        <p className="text-xs text-gray-400 mt-2">
          Approves the week and immediately sends personalised signup links to
          all active players. Use this if the Friday send time has already
          passed, or if you want to send early.
        </p>
      </div>

    </div>
  )
}