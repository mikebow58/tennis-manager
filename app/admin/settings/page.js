'use client'

// app/admin/settings/page.js
//
// Organiser-facing settings page. Lets the organiser edit, without needing
// database or Vercel access:
//   1. Admin email recipient(s) — admin_settings.admin_email
//   2. Default session start time — applied to all active default_sessions
//   3. Locations — full CRUD: name, address, total_courts, notes, and an
//      active/deactivate toggle (soft delete). New locations can be added
//      via a small inline form.
//
// THIS REVISION: locations section expanded from "total courts only" to full
// CRUD. Previously the organiser had no way to add a location, rename one,
// set/edit its address, or deactivate one without direct SQL access — this
// closes that gap. Deactivating is a soft delete (locations.active = false),
// consistent with how the rest of the app handles history (e.g. players).
//
// Each section saves independently via PUT /api/admin/settings, sending
// only the field(s) being changed. Creating a new location is a separate
// POST /api/admin/settings call (see handleAddLocation below).

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

  // Locations section state — array of
  // { id, name, address, totalCourts, notes, active }.
  // totalCourts is tracked as a string while editing so the input can be
  // momentarily empty without coercing to 0.
  const [locations, setLocations] = useState([])
  const [locationsSaving, setLocationsSaving] = useState(false)
  const [locationsStatus, setLocationsStatus] = useState(null)

  // New-location form state — kept separate from the main locations array
  // until the create call succeeds, so a half-filled "add" form never gets
  // mixed into the save-all-existing-locations payload.
  const [newLocation, setNewLocation] = useState({
    name: '',
    address: '',
    totalCourts: '',
    notes: '',
  })
  const [addingLocation, setAddingLocation] = useState(false)
  const [addLocationError, setAddLocationError] = useState(null)

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
          address: loc.address ?? '',
          totalCourts: String(loc.total_courts ?? ''),
          notes: loc.notes ?? '',
          active: loc.active,
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
  // Save: all existing locations together (batched, per the API contract).
  // Sends full field set for every location — the API only writes fields
  // present, but sending everything keeps this call simple and idempotent.
  // ------------------------------------------------------------------
  async function saveLocations() {
    setLocationsSaving(true)
    setLocationsStatus(null)
    try {
      const payload = locations.map((loc) => ({
        id: loc.id,
        name: loc.name,
        address: loc.address,
        totalCourts: parseInt(loc.totalCourts, 10),
        notes: loc.notes,
        active: loc.active,
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

  // Generic field updater for any editable column on an existing location row.
  function updateLocationField(locationId, field, value) {
    setLocations((prev) =>
      prev.map((loc) =>
        loc.id === locationId ? { ...loc, [field]: value } : loc
      )
    )
  }

  // Deactivate/reactivate is just a toggle of the `active` field, saved
  // immediately on click rather than waiting for the batch "Save" button —
  // this is a meaningfully different action from a routine text edit (it
  // changes whether the location shows up elsewhere in the app), so instant
  // feedback matters more here than for the other fields.
  async function toggleLocationActive(locationId, currentActive) {
    const newActive = !currentActive
    setLocations((prev) =>
      prev.map((loc) =>
        loc.id === locationId ? { ...loc, active: newActive } : loc
      )
    )

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: [{ id: locationId, active: newActive }] }),
      })
      const data = await res.json()
      const success = data?.results?.locations?.success
      if (!success) {
        // Revert the optimistic update if the save actually failed.
        setLocations((prev) =>
          prev.map((loc) =>
            loc.id === locationId ? { ...loc, active: currentActive } : loc
          )
        )
        alert('Could not update location status — try again.')
      }
    } catch (err) {
      console.error('[admin/settings] toggleLocationActive error:', err)
      setLocations((prev) =>
        prev.map((loc) =>
          loc.id === locationId ? { ...loc, active: currentActive } : loc
        )
      )
      alert('Could not update location status — try again.')
    }
  }

  // ------------------------------------------------------------------
  // Add a brand new location. Separate POST call, then append the result
  // to the main locations list on success and clear the form.
  // ------------------------------------------------------------------
  async function handleAddLocation() {
    setAddLocationError(null)

    const totalCourtsNum = parseInt(newLocation.totalCourts, 10)
    if (!newLocation.name.trim()) {
      setAddLocationError('Name is required.')
      return
    }
    if (isNaN(totalCourtsNum) || totalCourtsNum < 0) {
      setAddLocationError('Total courts must be a non-negative number.')
      return
    }

    setAddingLocation(true)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newLocation.name.trim(),
          address: newLocation.address.trim() || null,
          totalCourts: totalCourtsNum,
          notes: newLocation.notes.trim() || null,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setAddLocationError(data?.error || 'Could not add location.')
        return
      }

      // Append the newly created location to the existing list, in the
      // same shape used everywhere else on this page.
      setLocations((prev) => [
        ...prev,
        {
          id: data.location.id,
          name: data.location.name,
          address: data.location.address ?? '',
          totalCourts: String(data.location.total_courts ?? ''),
          notes: data.location.notes ?? '',
          active: data.location.active,
        },
      ])

      // Reset the add-location form for the next entry.
      setNewLocation({ name: '', address: '', totalCourts: '', notes: '' })
    } catch (err) {
      console.error('[admin/settings] handleAddLocation error:', err)
      setAddLocationError('Could not add location — try again.')
    } finally {
      setAddingLocation(false)
    }
  }

  // Disable the locations save button if any field is invalid — prevents
  // accidentally writing NaN, a negative court count, or an empty name.
  const locationsValid = locations.every((loc) => {
    const n = parseInt(loc.totalCourts, 10)
    return !isNaN(n) && n >= 0 && loc.name.trim().length > 0
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
          <h2 className="text-sm font-semibold text-gray-800">Locations</h2>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            Name, address, total courts, and notes for each location. Deactivating a location
            hides it from dropdowns elsewhere in the app without deleting its history.
          </p>

          {locations.length === 0 ? (
            <p className="text-sm text-gray-400">No locations found.</p>
          ) : (
            <div className="space-y-3">
              {locations.map((loc) => (
                <div
                  key={loc.id}
                  className={`border rounded-lg px-4 py-3 space-y-2 ${
                    loc.active ? 'border-gray-200' : 'border-gray-100 bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={loc.name}
                      onChange={(e) => updateLocationField(loc.id, 'name', e.target.value)}
                      placeholder="Location name"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-medium"
                    />
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-gray-500">Courts</label>
                      <input
                        type="number"
                        min="0"
                        value={loc.totalCourts}
                        onChange={(e) => updateLocationField(loc.id, 'totalCourts', e.target.value)}
                        className="w-16 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right"
                      />
                    </div>
                  </div>
                  <input
                    type="text"
                    value={loc.address}
                    onChange={(e) => updateLocationField(loc.id, 'address', e.target.value)}
                    placeholder="Address"
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    value={loc.notes}
                    onChange={(e) => updateLocationField(loc.id, 'notes', e.target.value)}
                    placeholder="Notes (e.g. parking, access instructions)"
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                  />
                  <div className="flex justify-between items-center pt-1">
                    <span className="text-xs text-gray-500">
                      {loc.active ? 'Active' : 'Inactive — hidden from dropdowns'}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleLocationActive(loc.id, loc.active)}
                      className={`text-xs font-medium ${
                        loc.active
                          ? 'text-red-500 hover:text-red-700'
                          : 'text-blue-600 hover:text-blue-700'
                      }`}
                    >
                      {loc.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
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
              {locationsSaving ? 'Saving...' : 'Save changes'}
            </button>

            {locationsStatus === 'success' && (
              <p className="text-xs text-green-700">Saved.</p>
            )}
            {locationsStatus === 'error' && (
              <p className="text-xs text-red-600">Could not save — try again.</p>
            )}
          </div>

          {/* -------------------------------------------------------- */}
          {/* Add new location                                          */}
          {/* -------------------------------------------------------- */}
          <div className="border-t border-gray-100 mt-5 pt-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Add a new location</h3>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input
                type="text"
                value={newLocation.name}
                onChange={(e) => setNewLocation((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Name"
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
              />
              <input
                type="number"
                min="0"
                value={newLocation.totalCourts}
                onChange={(e) =>
                  setNewLocation((prev) => ({ ...prev, totalCourts: e.target.value }))
                }
                placeholder="Total courts"
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
              />
            </div>
            <input
              type="text"
              value={newLocation.address}
              onChange={(e) => setNewLocation((prev) => ({ ...prev, address: e.target.value }))}
              placeholder="Address (optional)"
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm mb-2"
            />
            <input
              type="text"
              value={newLocation.notes}
              onChange={(e) => setNewLocation((prev) => ({ ...prev, notes: e.target.value }))}
              placeholder="Notes (optional)"
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm mb-2"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleAddLocation}
                disabled={addingLocation}
                className="bg-slate-700 text-white px-4 py-2 rounded-lg hover:bg-slate-800 text-sm font-medium disabled:opacity-40"
              >
                {addingLocation ? 'Adding...' : 'Add location'}
              </button>
              {addLocationError && (
                <p className="text-xs text-red-600">{addLocationError}</p>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}