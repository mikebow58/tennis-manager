'use client'

/**
 * NewPlayerPage
 *
 * Admin form for adding a new player to the database. Submits to
 * POST /api/players/new, which inserts the record directly via supabaseAdmin.
 *
 * V2 field notes:
 *   - mobile_number: V2 column name (was 'mobile' in V1 — renamed in schema migration)
 *   - skill_self: integer 1–5, maps to the self-reported NTRP scale (V2 spec Section 10)
 *   - skill_admin: integer 1–8, maps to the admin-rated scale (V2 spec Section 10)
 *   - player_type: REMOVED — dropped from V2 schema (to-do list item confirmed)
 *   - signup_token: generated client-side from lib/tokens before submit
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { generateToken } from '@/lib/tokens'
import Select from '@/app/components/Select'
import { getSkillOptions } from '@/lib/utils'

export default function NewPlayerPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)

  // Form state. Field names match V2 column names exactly so the cleaned
  // object can be submitted directly without mapping.
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    mobile_number: '',   // V2 column name — was 'mobile' in V1
    email: '',
    gender: '',
    skill_self: '',      // Integer 1–5 (self-reported NTRP scale)
    skill_admin: '',     // Integer 1–8 (admin-rated scale)
    active: true,
    notes: '',
  })

  // Generic change handler — works for all text inputs and selects.
  function handleChange(e) {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    // Build the insert payload. Convert skill fields from string (form input)
    // to integer or null — Supabase will reject a string for an integer column.
    // Generate signup_token here so every new player gets a unique token at
    // creation time. Token is static per player per V2 spec Section 6 (Phase 3).
    const cleaned = {
      ...form,
      skill_self: form.skill_self === '' ? null : Number(form.skill_self),
      skill_admin: form.skill_admin === '' ? null : Number(form.skill_admin),
      signup_token: generateToken(),
    }

    const res = await fetch('/api/players/new', {
      method: 'POST',
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

  // Self-reported skill options — integer 1–5 mapped to NTRP display labels.
  // These match the player-facing scale defined in V2 spec Section 10.
  const skillSelfOptions = [
    { value: '1', label: '2.5' },
    { value: '2', label: '3.0' },
    { value: '3', label: '3.5' },
    { value: '4', label: '4.0' },
    { value: '5', label: '4.5+' },
  ]

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      {/* Page header */}
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Add player</h1>
            <p className="text-xs text-slate-300 mt-0.5">New player profile</p>
          </div>
          <a href="/players" className="text-xs text-slate-300 hover:text-white">Cancel</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-2xl mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Name row */}
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

            {/* Mobile — field name is mobile_number in V2 schema */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Mobile</label>
              <input
                name="mobile_number"
                value={form.mobile_number}
                onChange={handleChange}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>

            {/* Email */}
            <div>
              <label className="block text-sm text-gray-600 mb-1">Email</label>
              <input
                name="email"
                value={form.email}
                onChange={handleChange}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>

            {/* Gender — player_type removed in V2; gender occupies full row now */}
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
            </div>

            {/* Skill ratings row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                {/* Self-reported skill: dropdown 1–5 matching the player-facing NTRP scale. */}
                <label className="block text-sm text-gray-600 mb-1">Skill (self-reported)</label>
                <Select
                  name="skill_self"
                  value={String(form.skill_self)}
                  onChange={handleChange}
                  placeholder="Select..."
                  options={skillSelfOptions}
                />
              </div>
              <div>
                {/* Admin-rated skill: dropdown 1–8 via getSkillOptions() from lib/utils. */}
                <label className="block text-sm text-gray-600 mb-1">Skill (admin rating)</label>
                <Select
                  name="skill_admin"
                  value={String(form.skill_admin)}
                  onChange={handleChange}
                  placeholder="Select rating..."
                  options={getSkillOptions()}
                />
              </div>
            </div>

            {/* Notes */}
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

            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              {saving ? 'Saving...' : 'Save player'}
            </button>

          </form>
        </div>
      </div>
    </div>
  )
}