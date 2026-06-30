'use client'

// app/admin/settings/page.js
//
// Organiser-facing settings page. Lets the organiser edit three things
// without needing database or Vercel access:
//   1. Admin email recipient(s) — admin_settings.admin_email
//   2. Default session start time — applied to all active default_sessions
//   3. Total courts per location — locations.total_courts
//
// Each section saves independently via PUT /api/admin/settings, sending
// only the field(s) being changed. Location renaming is intentionally not
// supported here — names are shown as read-only context only.

import { useState, useEffect } from 'react'
import Select from '@/app/components/Select'
import { getTimeOptions } from '@/lib/utils'

export default function AdminSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  // Admin email section state.
  const [adminEmail, setAdminEmailValue] = useState('')
  const [adminEmailSaving, setAdminEmailSaving] = useState(false)
  const [adminEmailStatus, setAdminEmailStatus] = useState(null) // 'success' | 'error' | null

  // Default start time section state.
  const [startTime, setStartTime] = useState('')
  const [startTimeSaving, setStartTimeSaving] = useState(false)
  const [startTimeStatus, setStartTimeStatus] = useState(null)

  // Locations section state — array of { id, name, totalCourts }.
  // totalCourts is tracked as a string while editing so the input can be
  // momentarily empty without coercing to 0.
  const [locations, setLocations] = useState([])
  const [locationsSaving, setLocationsSaving] = useState(false)
  const [locationsStatus, setLocationsStatus] = useState(null)

  useEffect(() => {
    fetchSettings()
  }, [])

  // ------------------------------------------------------------------
  // Initial load — fetch all three settings together.
  // ------------------------------------------------------------------
  async function fetchSettings() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/admin/settings')
      if (!res.ok) throw new Error('Failed to load settings')
      const data = await res.json()

      setAdminEmailValue(data.adminEmail ?? '')
      setStartTime(data.defaultStartTime ?? '')
      setLocations(
        (data.locations ?? []).map((loc) => ({
          id: loc.id,
          name: loc.name,
          totalCourts: String(loc.total_courts ?? ''),
        }))
      )
    } catch (err) {
      console.error('[admin/settings] fetchSettings error:', err)
      setLoadError('Could not load settings. Try refreshing the page.')
    } finally {
      setLoading(false)
    }
  }

  // ------------------------------------------------------------------
  // Save: admin email.
  // ------------------------------------------------------------------
  async function saveAdminEmail() {
    setAdminEmailSaving(true)
    setAdminEmailStatus(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail }),
      })
      const data = await res.json()
      const success = data?.results?.adminEmail?.success
      setAdminEmailStatus(success ? 'success' : 'error')
    } catch (err) {
      console.error('[admin/settings] saveAdminEmail error:', err)
      setAdminEmailStatus('error')
    } finally {
      setAdminEmailSaving(false)
      // Clear the status indicator after a moment so it doesn't linger
      // indefinitely once the organiser has moved on.
      setTimeout(() => setAdminEmailStatus(null), 3000)
    }
  }

  // ------------------------------------------------------------------
  // Save: default start time.
  // ------------------------------------------------------------------
  async function saveStartTime() {
    setStartTimeSaving(true)
    setStartTimeStatus(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultStartTime: startTime }),
      })
      const data = await res.json()
      const success = data?.results?.defaultStartTime?.success
      setStartTimeStatus(success ? 'success' : 'error')
    } catch (err) {
      console.error('[admin/settings] saveStartTime error:', err)
      setStartTimeStatus('error')
    } finally {
      setStartTimeSaving(false)
      setTimeout(() => setStartTimeStatus(null), 3000)
    }
  }

  // ------------------------------------------------------------------
  // Save: all locations together (batched, per the API contract).
  // ------------------------------------------------------------------
  async function saveLocations() {
    setLocationsSaving(true)
    setLocationsStatus(null)
    try {
      const payload = locations.map((loc) => ({
        id: loc.id,
        totalCourts: parseInt(loc.totalCourts, 10),
      }))

      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: payload }),
      })
      const data = await res.json()
      const success = data?.results?.locations?.success
      setLocationsStatus(success ? 'success' : 'error')
    } catch (err) {
      console.error('[admin/settings] saveLocations error:', err)
      setLocationsStatus('error')
    } finally {
      setLocationsSaving(false)
      setTimeout(() => setLocationsStatus(null), 3000)
    }
  }

  function updateLocationCourts(locationId, value) {
    setLocations((prev) =>
      prev.map((loc) =>
        loc.id === locationId ? { ...loc, totalCourts: value } : loc
      )
    )
  }

  // Disable the locations save button if any field is empty or invalid —
  // prevents accidentally writing NaN or a negative court count.
  const locationsValid = locations.every((loc) => {
    const n = parseInt(loc.totalCourts, 10)
    return !isNaN(n) && n >= 0
  })

  if (loading) {
    return <div className="min-h-screen bg-[#f1efe9]" />
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-xl font-semibold text-white">Settings</h1>
          <p className="text-xs text-slate-300 mt-0.5">
            Organiser-level configuration
          </p>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-3xl mx-auto space-y-4">
        {loadError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {loadError}
          </div>
        )}

        {/* ------------------------------------------------------------ */}
        {/* Admin email recipients                                       */}
        {/* ------------------------------------------------------------ */}
        <section className="bg-white border border-gray-200 rounded-xl px-6 py-5">
          <h2 className="text-sm font-semibold text-gray-800">Admin email recipients</h2>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            Where organiser notifications are sent. Separate multiple addresses with commas.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <input
              type="text"
              value={adminEmail}
              onChange={(e) => setAdminEmailValue(e.target.value)}
              placeholder="you@example.com, backup@example.com"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              onClick={saveAdminEmail}
              disabled={adminEmailSaving || adminEmail.trim().length === 0}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-40 disabled:hover:bg-blue-600 whitespace-nowrap"
            >
              {adminEmailSaving ? 'Saving...' : 'Save'}
            </button>
          </div>

          {adminEmailStatus === 'success' && (
            <p className="text-xs text-green-700 mt-2">Saved.</p>
          )}
          {adminEmailStatus === 'error' && (
            <p className="text-xs text-red-600 mt-2">Could not save — try again.</p>
          )}
        </section>

        {/* ------------------------------------------------------------ */}
        {/* Default session start time                                   */}
        {/* ------------------------------------------------------------ */}
        <section className="bg-white border border-gray-200 rounded-xl px-6 py-5">
          <h2 className="text-sm font-semibold text-gray-800">Default session start time</h2>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            Applied to every active default session day. You can still adjust an individual day's
            time after a week is created.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <div className="w-full sm:w-40">
              <Select
                name="start_time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                options={getTimeOptions()}
                placeholder="Select time..."
              />
            </div>
            <button
              onClick={saveStartTime}
              disabled={startTimeSaving || !startTime}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-40 disabled:hover:bg-blue-600 whitespace-nowrap"
            >
              {startTimeSaving ? 'Saving...' : 'Save'}
            </button>
          </div>

          {startTimeStatus === 'success' && (
            <p className="text-xs text-green-700 mt-2">Saved.</p>
          )}
          {startTimeStatus === 'error' && (
            <p className="text-xs text-red-600 mt-2">Could not save — try again.</p>
          )}
        </section>

        {/* ------------------------------------------------------------ */}
        {/* Locations & courts                                            */}
        {/* ------------------------------------------------------------ */}
        <section className="bg-white border border-gray-200 rounded-xl px-6 py-5">
          <h2 className="text-sm font-semibold text-gray-800">Locations & courts</h2>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            Total courts available at each location. To rename or add a location, contact your developer.
          </p>

          {locations.length === 0 ? (
            <p className="text-sm text-gray-400">No locations found.</p>
          ) : (
            <div className="space-y-2">
              {locations.map((loc) => (
                <div
                  key={loc.id}
                  className="flex items-center justify-between gap-3 border border-gray-100 rounded-lg px-4 py-2.5"
                >
                  <span className="text-sm text-gray-800">{loc.name}</span>
                  <input
                    type="number"
                    min="0"
                    value={loc.totalCourts}
                    onChange={(e) => updateLocationCourts(loc.id, e.target.value)}
                    className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={saveLocations}
              disabled={locationsSaving || !locationsValid || locations.length === 0}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-40 disabled:hover:bg-blue-600"
            >
              {locationsSaving ? 'Saving...' : 'Save'}
            </button>

            {locationsStatus === 'success' && (
              <p className="text-xs text-green-700">Saved.</p>
            )}
            {locationsStatus === 'error' && (
              <p className="text-xs text-red-600">Could not save — try again.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}