/**
 * EditSessionClient
 *
 * Client component for the session edit form.
 * Receives server-fetched session and locations as props.
 * Saves changes via PATCH /api/sessions/[sessionId].
 *
 * Fields: start_time, location_id, courts_available, format, notes.
 * Date and status are intentionally not editable here.
 */

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getTimeOptions, formatTime } from '@/lib/utils'

export default function EditSessionClient({ session, locations, sessionDateLabel, weekId }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [startTime, setStartTime] = useState(session.start_time || '')
  const [locationId, setLocationId] = useState(
    session.location_id ? String(session.location_id) : ''
  )
  const [courtsAvailable, setCourtsAvailable] = useState(session.courts_available ?? '')
  const [format, setFormat] = useState(session.format || 'switch_partners')
  const [notes, setNotes] = useState(session.notes || '')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    const res = await fetch(`/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_time: startTime || null,
        location_id: locationId || null,
        courts_available: parseInt(courtsAvailable, 10) || null,
        format: format || null,
        notes: notes.trim() || null,
      }),
    })

    if (!res.ok) {
      alert('Error saving session.')
      setSaving(false)
      return
    }

    router.push(`/weeks/${weekId}/sessions/${session.id}`)
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      'Are you sure you want to delete this session? This will also remove all player signups for this day.'
    )
    if (!confirmed) return

    setDeleting(true)

    const res = await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' })

    if (!res.ok) {
      alert('Error deleting session.')
      setDeleting(false)
      return
    }

    router.push(`/weeks/${weekId}`)
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-lg mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Edit session</h1>
            <p className="text-xs text-slate-300 mt-0.5">{sessionDateLabel}</p>
          </div>
          
            <a href={`/weeks/${weekId}/sessions/${session.id}`}
            className="text-xs text-slate-300 hover:text-white"
          >
            Cancel
          </a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-lg mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Start time */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Start time</label>
              <select
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select time —</option>
                {getTimeOptions().map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Location */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Location</label>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select location —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={String(loc.id)}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Courts available */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Courts available
              </label>
              <input
                type="number"
                min="1"
                max="20"
                value={courtsAvailable}
                onChange={(e) => setCourtsAvailable(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400 mt-1">
                Session capacity = courts × 4 players
              </p>
            </div>

            {/* Format */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Play format</label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="switch_partners">Switch partners</option>
                <option value="keep_partners">Keep partners</option>
              </select>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Note to players{' '}
                <span className="font-normal text-gray-400">(included in reminder email)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="e.g. Meet at court 3 entrance"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex justify-between items-center pt-2">
              <button
                type="submit"
                disabled={saving || deleting}
                className="bg-gray-900 text-white px-6 py-2.5 rounded-lg hover:bg-gray-700 disabled:opacity-50 text-sm font-medium"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || saving}
                className="text-red-500 text-sm hover:text-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete session'}
              </button>
            </div>

          </form>
        </div>
      </div>
    </div>
  )
}