/**
 * NewSessionClient
 *
 * Client component for the new session form.
 * V2 field names: courts_available (replaces court_count),
 * location_id FK (replaces freeform location text).
 */

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Select from '@/app/components/Select'
import { getTimeOptions } from '@/lib/utils'

export default function NewSessionClient({ weekId, locations }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    session_date: '',
    start_time: '09:00:00',
    location_id: '',
    courts_available: 2,
    format: 'switch_partners',
    notes: '',
  })

  function handleChange(e) {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    const res = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        week_id: weekId,
        session_date: form.session_date,
        start_time: form.start_time,
        location_id: form.location_id || null,
        courts_available: Number(form.courts_available),
        format: form.format,
        notes: form.notes.trim() || null,
        status: 'open',
      }),
    })

    if (!res.ok) {
      alert('Error saving session.')
      setSaving(false)
      return
    }

    router.push(`/weeks/${weekId}`)
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-lg mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Add session</h1>
            <p className="text-xs text-slate-300 mt-0.5">New play day for this week</p>
          </div>
          
            <a href={`/weeks/${weekId}`}
            className="text-xs text-slate-300 hover:text-white"
          >
            Cancel
          </a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-lg mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Date */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Date</label>
              <input
                type="date"
                name="session_date"
                value={form.session_date}
                onChange={handleChange}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Start time */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Start time</label>
              <Select
                name="start_time"
                value={form.start_time}
                onChange={handleChange}
                options={getTimeOptions()}
                placeholder="Select time..."
              />
            </div>

            {/* Location — dropdown from locations master record */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Location</label>
              <select
                name="location_id"
                value={form.location_id}
                onChange={handleChange}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select location —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
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
                name="courts_available"
                value={form.courts_available}
                onChange={handleChange}
                min="1"
                max="20"
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400 mt-1">
                Session capacity = courts × 4 players
              </p>
            </div>

            {/* Format */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Play format</label>
              <Select
                name="format"
                value={form.format}
                onChange={handleChange}
                options={[
                  { value: 'switch_partners', label: 'Switch partners' },
                  { value: 'keep_partners', label: 'Keep partners' },
                ]}
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Note to players{' '}
                <span className="font-normal text-gray-400">(included in reminder email)</span>
              </label>
              <textarea
                name="notes"
                value={form.notes}
                onChange={handleChange}
                rows={2}
                placeholder="e.g. Arrive 10 min early · Bring a can of balls"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              {saving ? 'Saving…' : 'Add session'}
            </button>

          </form>
        </div>
      </div>
    </div>
  )
}