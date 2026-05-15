/**
 * ApproveWeekClient
 *
 * Client component: renders one session row on the approve page.
 * When isEditable is true (week is in pending_approval), the organiser
 * can expand the row to edit start_time, courts_available, location, and notes.
 * Edits are saved immediately via PATCH /api/sessions/[sessionId].
 *
 * When isEditable is false (week already approved/sent/closed), the row
 * is read-only — no expand affordance shown.
 *
 * @param {object}   props
 * @param {object}   props.session    - Session record from DB (includes locations: { name } join)
 * @param {string}   props.dateLabel  - Human-readable date string
 * @param {boolean}  props.isEditable - Whether inline editing is allowed
 * @param {string}   props.weekId     - Parent week UUID (for nav link)
 * @param {object[]} props.locations  - Active location records [{ id, name }]
 * @param {function} props.onDelete   - Callback to remove this session from parent list state
 */

'use client'

import { useState } from 'react'
import { formatTime, getTimeOptions } from '@/lib/utils'

export default function ApproveWeekClient({ session, dateLabel, isEditable, weekId, locations, onDelete }) {
  // Controls whether the inline edit form is expanded
  const [expanded, setExpanded] = useState(false)

  // Editable field state — initialised from the session record
  const [startTime, setStartTime] = useState(session.start_time || '')
  const [courtsAvailable, setCourtsAvailable] = useState(session.courts_available ?? '')
  const [notes, setNotes] = useState(session.notes || '')

  // Location state — track the selected location_id so the subtitle stays live
  // after a save without needing a page reload or re-fetch
  const [locationId, setLocationId] = useState(session.location_id || '')

  // Derive the display name from the current locationId against the locations list.
  // This updates immediately when the organiser changes the dropdown selection,
  // and remains correct after a save because locationId is in state.
  const locationName =
    locations?.find((loc) => loc.id === locationId)?.name ?? session.locations?.name ?? '—'

  // Two-tap delete confirmation state
  const [deleteStage, setDeleteStage] = useState('idle') // 'idle' | 'confirm'
  const [deleting, setDeleting] = useState(false)

  // Tracks save state for user feedback
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null) // 'saved' | 'error' | null

  /**
   * Saves the current inline edit values to the session via PATCH.
   * Includes location_id so the location is persisted correctly.
   */
  async function handleSave() {
    console.log('[ApproveWeekClient] locationId at save:', locationId, 'locations prop:', locations)
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
          location_id: locationId || null,
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

  /**
   * First tap: move to confirm stage.
   * Second tap: send DELETE and remove the row from parent state via onDelete.
   */
  async function handleDeleteClick() {
    if (deleteStage === 'idle') {
      setDeleteStage('confirm')
      return
    }

    // Second tap — confirmed
    setDeleting(true)
    try {
      const res = await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' })
      if (res.ok) {
        onDelete(session.id)
      } else {
        console.error('[ApproveWeekClient] Delete failed:', await res.text())
        setDeleteStage('idle')
      }
    } catch (err) {
      console.error('[ApproveWeekClient] Delete error:', err)
      setDeleteStage('idle')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* ── Summary row ── */}
      <div className="px-4 py-3 flex justify-between items-center">
        <div>
          <div className="text-sm font-medium text-gray-900">{dateLabel}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {/* Location name derives from current locationId state — stays live after save */}
            {startTime ? formatTime(startTime) : '—'} · {locationName} · {courtsAvailable || '—'}{' '}
            {Number(courtsAvailable) === 1 ? 'court' : 'courts'}
            {notes && <span className="text-gray-400"> · has note</span>}
          </div>
        </div>

        {/* Edit toggle — only shown when week is in pending_approval */}
        {isEditable && (
          <button
            onClick={() => {
              setExpanded((prev) => !prev)
              // Reset delete confirmation if the edit panel is toggled
              setDeleteStage('idle')
            }}
            className="text-sm text-blue-600 hover:underline ml-4 shrink-0"
          >
            {expanded ? 'Close' : 'Edit'}
          </button>
        )}
      </div>

      {/* ── Inline edit form — visible only when expanded ── */}
      {expanded && isEditable && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-100 space-y-3">

          {/* Start time — on the hour or half hour only */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Start time
            </label>
            <select
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full max-w-[160px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {getTimeOptions().map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Location — dropdown from active locations master record */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Location
            </label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full max-w-[240px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Select location —</option>
              {locations?.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
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

          {/* Save / delete / feedback row */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>

            {/* Two-tap delete: first tap shows red confirm button, second tap deletes */}
            {deleteStage === 'idle' && (
              <button
                onClick={handleDeleteClick}
                className="text-sm text-red-500 hover:text-red-700"
              >
                Delete
              </button>
            )}
            {deleteStage === 'confirm' && (
              <button
                onClick={handleDeleteClick}
                disabled={deleting}
                className="text-sm text-white bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
            )}

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