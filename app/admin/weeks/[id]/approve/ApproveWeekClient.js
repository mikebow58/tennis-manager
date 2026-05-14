/**
 * ApproveWeekClient
 *
 * Client component: renders one session row on the approve page.
 * When isEditable is true (week is in pending_approval), the organiser
 * can expand the row to edit start_time, courts_available, location, and notes.
 * Edits are saved immediately via PATCH /api/sessions/[sessionId].
 *
 * The organiser can also delete the session from the expanded edit form.
 * Deletion calls DELETE /api/sessions/[sessionId] and then notifies the
 * parent (SessionListClient) via the onDelete callback to remove the row
 * from state — no page reload required.
 *
 * When isEditable is false (week already approved/sent/closed), the row
 * is read-only — no expand affordance shown.
 *
 * @param {object}    props
 * @param {object}    props.session    - Session record from DB (includes location_id)
 * @param {string}    props.dateLabel  - Human-readable date string
 * @param {boolean}   props.isEditable - Whether inline editing is allowed
 * @param {string}    props.weekId     - Parent week UUID (for nav link)
 * @param {object[]}  props.locations  - Active locations array [{ id, name }]
 * @param {function}  props.onDelete   - Callback called with sessionId after successful delete
 */

'use client'

import { useState } from 'react'
import { formatTime, getTimeOptions } from '@/lib/utils'

export default function ApproveWeekClient({ session, dateLabel, isEditable, weekId, locations = [], onDelete }) {
  // Controls whether the inline edit form is expanded
  const [expanded, setExpanded] = useState(false)

  // Editable field state — initialised from the session record
  const [startTime, setStartTime]         = useState(session.start_time || '')
  const [courtsAvailable, setCourtsAvailable] = useState(session.courts_available ?? '')
  const [locationId, setLocationId]       = useState(session.location_id || '')
  const [notes, setNotes]                 = useState(session.notes || '')

  // Save state for user feedback
  const [saving, setSaving]         = useState(false)
  const [saveResult, setSaveResult] = useState(null) // 'saved' | 'error' | null

  // Delete state — tracks confirmation step and in-flight status
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting]               = useState(false)
  const [deleteError, setDeleteError]         = useState(false)

  /**
   * Resolves the display name for the currently selected location.
   * Returns '—' when no location is selected or the id doesn't match
   * any entry in the locations array (e.g. location not yet set on session).
   *
   * @returns {string}
   */
  function currentLocationName() {
    if (!locationId) return '—'
    const match = locations.find((l) => l.id === locationId)
    return match ? match.name : '—'
  }

  /**
   * Saves the current inline edit values to the session via
   * PATCH /api/sessions/[sessionId].
   * Sends all editable fields in one payload — the API handler
   * accepts partial updates via Supabase's update() method.
   */
  async function handleSave() {
    setSaving(true)
    setSaveResult(null)

    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_time:       startTime,
          courts_available: parseInt(courtsAvailable, 10) || null,
          // Send null explicitly when no location selected, so the DB
          // field is cleared rather than left with a stale value
          location_id:      locationId || null,
          notes:            notes.trim() || null,
        }),
      })

      if (res.ok) {
        setSaveResult('saved')
        // Collapse the edit form after a short delay so the organiser
        // sees the confirmation before the row returns to summary view
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
   * Deletes the session via DELETE /api/sessions/[sessionId].
   * The API handler cleans up availability rows first, then deletes
   * the session record. On success, calls onDelete(session.id) so
   * the parent (SessionListClient) removes this row from its state.
   */
  async function handleDelete() {
    setDeleting(true)
    setDeleteError(false)

    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: 'DELETE',
      })

      if (res.ok) {
        // Notify parent to remove this row from the sessions list
        onDelete(session.id)
      } else {
        console.error('[ApproveWeekClient] Delete failed:', await res.text())
        setDeleteError(true)
        setDeleting(false)
        setConfirmingDelete(false)
      }
    } catch (err) {
      console.error('[ApproveWeekClient] Delete error:', err)
      setDeleteError(true)
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">

      {/* ── Summary row ── */}
      <div className="px-4 py-3 flex justify-between items-center">
        <div>
          <div className="text-sm font-medium text-gray-900">{dateLabel}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {/* Reflects in-form edits in real time as the organiser changes fields */}
            {startTime ? formatTime(startTime) : '—'} · {courtsAvailable || '—'}{' '}
            {courtsAvailable === 1 ? 'court' : 'courts'} · {currentLocationName()}
            {notes && <span className="text-gray-400"> · has note</span>}
          </div>
        </div>

        {/* Edit toggle — only shown when week is in pending_approval */}
        {isEditable && (
          <button
            onClick={() => {
              setExpanded((prev) => !prev)
              // Reset delete confirmation if the form is being collapsed
              if (expanded) setConfirmingDelete(false)
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

          {/* Location — dropdown populated from active locations */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Location
            </label>
            {locations.length === 0 ? (
              // Graceful fallback if no locations exist in the DB yet
              <p className="text-xs text-gray-400">No locations configured.</p>
            ) : (
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full max-w-[260px] focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {/* Blank option allows the organiser to explicitly clear the location */}
                <option value="">— select location —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            )}
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
              placeholder="e.g. Arrive 10 minutes early for warmup."
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* ── Save / feedback row ── */}
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

          {/* ── Delete section — separated visually from the save row ── */}
          <div className="pt-3 border-t border-gray-100">
            {!confirmingDelete ? (
              // Initial delete button — requires a second tap to confirm
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-sm text-red-500 hover:text-red-700 hover:underline"
              >
                Delete session
              </button>
            ) : (
              // Confirmation step — makes accidental deletion very unlikely
              <div className="space-y-2">
                <p className="text-sm text-red-600 font-medium">
                  Delete this session? This cannot be undone.
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                    className="text-sm text-gray-500 hover:underline disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
                {deleteError && (
                  <p className="text-sm text-red-500">Delete failed — try again</p>
                )}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}