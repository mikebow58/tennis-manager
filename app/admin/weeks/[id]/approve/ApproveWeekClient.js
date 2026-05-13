/**
 * ApproveWeekClient
 *
 * Client component: renders one session row on the approve page.
 * When isEditable is true (week is in pending_approval), the organiser
 * can expand the row to edit start_time, courts_available, and notes.
 * Edits are saved immediately via PUT /api/sessions/[sessionId].
 *
 * When isEditable is false (week already approved/sent/closed), the row
 * is read-only — no expand affordance shown.
 *
 * @param {object}  props
 * @param {object}  props.session    - Session record from DB
 * @param {string}  props.dateLabel  - Human-readable date string
 * @param {boolean} props.isEditable - Whether inline editing is allowed
 * @param {string}  props.weekId     - Parent week UUID (for nav link)
 */

'use client'

import { useState } from 'react'
import { formatTime } from '@/lib/utils'

export default function ApproveWeekClient({ session, dateLabel, isEditable, weekId }) {
  // Controls whether the inline edit form is expanded
  const [expanded, setExpanded] = useState(false)

  // Editable field state — initialised from the session record
  const [startTime, setStartTime] = useState(session.start_time || '')
  const [courtsAvailable, setCourtsAvailable] = useState(session.courts_available ?? '')
  const [notes, setNotes] = useState(session.notes || '')

  // Tracks save state for user feedback
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null) // 'saved' | 'error' | null

  /**
   * Saves the current inline edit values to the session via the existing
   * PUT /api/sessions/[sessionId] route.
   */
  async function handleSave() {
    setSaving(true)
    setSaveResult(null)

    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_time: startTime,
          courts_available: parseInt(courtsAvailable, 10) || null,
          notes: notes.trim() || null,
        }),
      })

      if (res.ok) {
        setSaveResult('saved')
        // Collapse the edit form after a short delay so the organiser
        // can see the confirmation before the row returns to summary view
        setTimeout(() => {
          setExpanded(false)
          setSaveResult(null)
        }, 1200)
      } else {
        console.error('[ApproveWeekClient] Save failed:', await res.text())
        setSaveResult('error')
      }
    } catch (err) {
      console.error('[ApproveWeekClient] Save error:', err)
      setSaveResult('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* ── Summary row ── */}
      <div className="px-4 py-3 flex justify-between items-center">
        <div>
          <div className="text-sm font-medium text-gray-900">{dateLabel}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {/* Display current values — reflects any in-form edits in real time */}
            {startTime ? formatTime(startTime) : '—'} · {courtsAvailable || '—'}{' '}
            {courtsAvailable === 1 ? 'court' : 'courts'}
            {notes && <span className="text-gray-400"> · has note</span>}
          </div>
        </div>

        {/* Edit toggle — only shown when week is in pending_approval */}
        {isEditable && (
          <button
            onClick={() => setExpanded((prev) => !prev)}
            className="text-sm text-blue-600 hover:underline ml-4 shrink-0"
          >
            {expanded ? 'Close' : 'Edit'}
          </button>
        )}
      </div>

      {/* ── Inline edit form — visible only when expanded ── */}
      {expanded && isEditable && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-100 space-y-3">

          {/* Start time */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Start time
            </label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full max-w-[160px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Courts available */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Courts available
            </label>
            <input
              type="number"
              min="1"
              max="20"
              value={courtsAvailable}
              onChange={(e) => setCourtsAvailable(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full max-w-[100px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Session capacity = courts × 4 players
            </p>
          </div>

          {/* Notes (player-facing — included in reminder email) */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Note to players{' '}
              <span className="font-normal text-gray-400">(included in reminder email)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Meet at court 3 entrance"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Save / feedback row */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>

            {saveResult === 'saved' && (
              <span className="text-sm text-green-600">Saved</span>
            )}
            {saveResult === 'error' && (
              <span className="text-sm text-red-500">Save failed — try again</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}