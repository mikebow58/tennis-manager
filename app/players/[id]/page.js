'use client'

// app/players/[id]/page.js
//
// Organiser-facing player edit page. Also see app/api/players/[id]/route.js
// for the PATCH handler this form submits to.
//
// BUG FIX (this revision): the form previously sent `mobile` and `player_type`
// fields, neither of which exists as a column on the V2 `players` table — every
// save was silently failing against the database (PostgREST rejects unknown
// columns). Fixed by renaming to `mobile_number` and dropping `player_type`
// entirely (it was already slated for removal per the Project Summary TODO list).
//
// NEW THIS REVISION: three fields that previously had no admin UI at all, despite
// already existing in the schema and being actively read by lib/targeting.js:
//   - unavailable_days       (text[])  — hard constraint, excludes player from
//                                        fill-in/sub broadcasts on those days
//   - match_type_preferences (text[])  — soft preference, used to prioritise
//                                        First Call broadcasts by match type
//   - first_call             (boolean) — flags player as amenable to fill-in asks
//
// IMPORTANT — exact stored value formats (must match lib/targeting.js exactly,
// or the exclusion/matching logic will silently fail to work):
//   unavailable_days values:       'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday'
//                                   | 'Friday' | 'Saturday'
//     (full capitalised weekday name — matches the output of
//      Date.prototype.toLocaleDateString(..., { weekday: 'long' }) used in
//      lib/targeting.js's getDayOfWeekLabel(). No Sunday option since no
//      Sunday sessions exist.)
//   match_type_preferences values: 'doubles' | 'mixed_doubles' | 'singles'
//                                   | 'singles_emergency'
//     (lowercase, underscored — matches sessions.match_type exactly for the
//      first three values. 'singles_emergency' is stored for informational/
//      future use only — no session ever has match_type = 'singles_emergency',
//      so a player with only this preference set is NOT excluded from regular
//      doubles/mixed-doubles First Call broadcasts. This is intentional —
//      confirmed with the organiser: a player willing to sub emergency singles
//      is assumed fine being asked for doubles too.)

import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Select from '@/app/components/Select'
import { getSkillOptions } from '@/lib/utils'

// Days a session can actually run on — Monday through Saturday only.
const UNAVAILABLE_DAY_OPTIONS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

// Match type preference checkboxes. `value` is the exact string stored in
// match_type_preferences and compared against in lib/targeting.js.
const MATCH_TYPE_OPTIONS = [
  { value: 'doubles', label: 'Doubles' },
  { value: 'mixed_doubles', label: 'Mixed Doubles' },
  { value: 'singles', label: 'Singles' },
  { value: 'singles_emergency', label: 'Singles (emergency only)' },
]

export default function EditPlayerPage({ params: paramsPromise }) {
  const params = React.use(paramsPromise)
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    mobile_number: '',
    email: '',
    gender: '',
    skill_self: '',
    skill_admin: '',
    active: true,
    notes: '',
    first_call: false,
    unavailable_days: [],
    match_type_preferences: [],
  })

  useEffect(() => {
    async function loadPlayer() {
      const res = await fetch(`/api/players/${params.id}`)
      if (!res.ok) return
      const data = await res.json()
      setForm({
        first_name: data.first_name || '',
        last_name: data.last_name || '',
        mobile_number: data.mobile_number || '',
        email: data.email || '',
        gender: data.gender || '',
        skill_self: data.skill_self ?? '',
        skill_admin: data.skill_admin ?? '',
        active: data.active ?? true,
        notes: data.notes || '',
        first_call: data.first_call ?? false,
        // Default to empty arrays rather than null — keeps the checkbox
        // logic below simple (no null-checks needed at render time).
        unavailable_days: data.unavailable_days ?? [],
        match_type_preferences: data.match_type_preferences ?? [],
      })
      setLoading(false)
    }
    loadPlayer()
  }, [params.id])

  // Handles all simple (non-array) fields — text inputs, selects, and the
  // single active/first_call checkboxes.
  function handleChange(e) {
    const { name, value, type, checked } = e.target
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  // Toggles a single day in unavailable_days. Adds if absent, removes if present —
  // standard checkbox-group-as-array pattern.
  function toggleUnavailableDay(day) {
    setForm((prev) => {
      const current = prev.unavailable_days
      const next = current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day]
      return { ...prev, unavailable_days: next }
    })
  }

  // Same pattern for match_type_preferences.
  function toggleMatchTypePreference(value) {
    setForm((prev) => {
      const current = prev.match_type_preferences
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value]
      return { ...prev, match_type_preferences: next }
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    const cleaned = {
      ...form,
      skill_self: form.skill_self === '' ? null : Number(form.skill_self),
      skill_admin: form.skill_admin === '' ? null : Number(form.skill_admin),
    }

    const res = await fetch(`/api/players/${params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleaned),
    })

    if (!res.ok) {
      alert('Error saving player.')
      setSaving(false)
      return
    }

    router.push('/players')
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      `Are you sure you want to delete ${form.first_name} ${form.last_name}? This cannot be undone.`
    )
    if (!confirmed) return

    const res = await fetch(`/api/players/${params.id}`, { method: 'DELETE' })

    if (!res.ok) {
      alert('Error deleting player.')
      return
    }

    router.push('/players')
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f1efe9] flex items-center justify-center text-gray-500 text-sm">
        Loading...
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Edit player</h1>
            <p className="text-xs text-slate-300 mt-0.5">
              {form.first_name} {form.last_name}
            </p>
          </div>
          <a href="/players" className="text-xs text-slate-300 hover:text-white">
            Cancel
          </a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-2xl mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">First name</label>
                <input
                  name="first_name"
                  value={form.first_name}
                  onChange={handleChange}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Last name</label>
                <input
                  name="last_name"
                  value={form.last_name}
                  onChange={handleChange}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Mobile</label>
              <input
                name="mobile_number"
                value={form.mobile_number}
                onChange={handleChange}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Email</label>
              <input
                name="email"
                value={form.email}
                onChange={handleChange}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Gender</label>
                <Select
                  name="gender"
                  value={form.gender}
                  onChange={handleChange}
                  placeholder="Select..."
                  options={[
                    { value: 'M', label: 'Male' },
                    { value: 'F', label: 'Female' },
                    { value: 'Other', label: 'Other' },
                  ]}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Skill (self-reported)</label>
                <input
                  name="skill_self"
                  value={form.skill_self}
                  onChange={handleChange}
                  type="number"
                  min="1"
                  max="7"
                  step="0.5"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Skill (admin rating)</label>
              <Select
                name="skill_admin"
                value={String(form.skill_admin)}
                onChange={handleChange}
                placeholder="Select rating..."
                options={getSkillOptions()}
              />
            </div>

            {/* ---------------------------------------------------------- */}
            {/* First Call flag                                            */}
            {/* ---------------------------------------------------------- */}
            <div className="border-t border-gray-100 pt-4">
              <label className="flex items-center gap-2 text-sm text-gray-700 font-medium">
                <input
                  type="checkbox"
                  name="first_call"
                  checked={form.first_call}
                  onChange={handleChange}
                />
                First Call
              </label>
              <p className="text-xs text-gray-500 mt-1">
                Contacted first for fill-in and sub requests when a session needs players.
              </p>
            </div>

            {/* ---------------------------------------------------------- */}
            {/* Unavailable Days — hard constraint                         */}
            {/* ---------------------------------------------------------- */}
            <div className="border-t border-gray-100 pt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Unavailable days
              </label>
              <p className="text-xs text-gray-500 mb-2">
                This player is never contacted for fill-in or sub requests on these days,
                regardless of urgency.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {UNAVAILABLE_DAY_OPTIONS.map((day) => (
                  <label key={day} className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.unavailable_days.includes(day)}
                      onChange={() => toggleUnavailableDay(day)}
                    />
                    {day}
                  </label>
                ))}
              </div>
            </div>

            {/* ---------------------------------------------------------- */}
            {/* Match Type Preferences — soft preference                   */}
            {/* ---------------------------------------------------------- */}
            <div className="border-t border-gray-100 pt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Match type preferences
              </label>
              <p className="text-xs text-gray-500 mb-2">
                Used to prioritise First Call broadcasts. Leave all unchecked to be treated
                as compatible with every match type.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {MATCH_TYPE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.match_type_preferences.includes(opt.value)}
                      onChange={() => toggleMatchTypePreference(opt.value)}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  name="active"
                  checked={form.active}
                  onChange={handleChange}
                />
                Active player
              </label>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Notes</label>
              <textarea
                name="notes"
                value={form.notes}
                onChange={handleChange}
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-between items-center pt-2">
              <button
                type="submit"
                disabled={saving}
                className="bg-blue-600 text-white px-6 py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
              >
                {saving ? 'Saving...' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="text-red-500 text-sm hover:text-red-700"
              >
                Delete player
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}