/**
 * CancelSessionButton
 *
 * Client component rendered on the session detail page
 * (app/weeks/[id]/sessions/[sessionId]/page.js) when the session has NOT
 * yet been cancelled. Two-stage interaction, same pattern as the two-tap
 * delete confirmation elsewhere in this app:
 *
 *   Stage 1 (idle): a plain "Cancel this session" link/button.
 *   Stage 2 (confirm): an inline panel with an optional freeform reason
 *     textarea, a confirm button, and a "Back" button to abandon.
 *
 * On confirm, POSTs to /api/sessions/[sessionId]/cancel, which sets
 * sessions.cancelled_at + cancellation_note, closes any active sub_request,
 * and emails confirmed players (only) with the optional reason included.
 * See that route's file header for the full design (organiser's simplified
 * "Option D" — no status transition, no reinstatement path, session stays
 * in the database).
 *
 * On success, calls router.refresh() so the parent server component
 * re-fetches and this button is replaced by the cancelled banner.
 */

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function CancelSessionButton({ sessionId }) {
  const router = useRouter()
  const [stage, setStage] = useState('idle') // 'idle' | 'confirm'
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleConfirm() {
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/sessions/${sessionId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancellationNote: note.trim() || null }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Error cancelling session.')
        setSubmitting(false)
        return
      }

      router.refresh()
    } catch (err) {
      console.error('[CancelSessionButton] error:', err)
      setError('Error cancelling session.')
      setSubmitting(false)
    }
  }

  if (stage === 'idle') {
    return (
      <button
        onClick={() => setStage('confirm')}
        className="text-sm text-red-600 hover:text-red-800 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50"
      >
        Cancel this session
      </button>
    )
  }

  return (
    <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 space-y-2">
      <div className="text-sm font-medium text-red-800">Cancel this session?</div>
      <p className="text-xs text-red-700">
        Confirmed players will receive an immediate email letting them know the session is
        cancelled. Tentative and waitlisted players are not notified, since they haven't yet
        been told they're playing.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Optional — reason for cancelling (e.g. Weather — courts are wet)"
        className="w-full border border-red-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-400"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleConfirm}
          disabled={submitting}
          className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
        >
          {submitting ? 'Cancelling…' : 'Confirm cancellation'}
        </button>
        <button
          onClick={() => {
            setStage('idle')
            setError(null)
          }}
          disabled={submitting}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Back
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}