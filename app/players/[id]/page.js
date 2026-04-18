'use client'

import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Select from '@/app/components/Select'
import { getSkillOptions } from '@/lib/utils'

export default function EditPlayerPage({ params: paramsPromise }) {
  const params = React.use(paramsPromise)  
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    mobile: '',
    email: '',
    gender: '',
    skill_self: '',
    skill_admin: '',
    player_type: 'regular',
    active: true,
    notes: '',
  })

  useEffect(() => {
  async function loadPlayer() {
    const res = await fetch(`/api/players/${params.id}`)
    if (!res.ok) return
    const data = await res.json()
    setForm({
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      mobile: data.mobile || '',
      email: data.email || '',
      gender: data.gender || '',
      skill_self: data.skill_self ?? '',
      skill_admin: data.skill_admin ?? '',
      player_type: data.player_type || 'regular',
      active: data.active ?? true,
      notes: data.notes || '',
    })
    setLoading(false)
  }
  loadPlayer()
}, [params.id])

  function handleChange(e) {
    const { name, value, type, checked } = e.target
    setForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }))
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
    body: JSON.stringify(cleaned)
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
    return <div className="min-h-screen bg-[#f1efe9] flex items-center justify-center text-gray-500 text-sm">Loading...</div>
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Edit player</h1>
            <p className="text-xs text-slate-300 mt-0.5">{form.first_name} {form.last_name}</p>
          </div>
          <a href="/players" className="text-xs text-slate-300 hover:text-white">Cancel</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-2xl mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">First name</label>
                <input name="first_name" value={form.first_name} onChange={handleChange} required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Last name</label>
                <input name="last_name" value={form.last_name} onChange={handleChange} required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Mobile</label>
              <input name="mobile" value={form.mobile} onChange={handleChange} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Email</label>
              <input name="email" value={form.email} onChange={handleChange} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Gender</label>
                <Select name="gender" value={form.gender} onChange={handleChange} placeholder="Select..." options={[
                  { value: 'M', label: 'Male' },
                  { value: 'F', label: 'Female' },
                  { value: 'Other', label: 'Other' },
                ]} />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Player type</label>
                <Select name="player_type" value={form.player_type} onChange={handleChange} options={[
                  { value: 'regular', label: 'Regular' },
                  { value: 'flex', label: 'Flex' },
                  { value: 'sub', label: 'Sub only' },
                ]} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Skill (self-reported)</label>
                <input name="skill_self" value={form.skill_self} onChange={handleChange} type="number" min="1" max="7" step="0.5" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
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
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input type="checkbox" name="active" checked={form.active} onChange={handleChange} />
                Active player
              </label>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Notes</label>
              <textarea name="notes" value={form.notes} onChange={handleChange} rows={3} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="flex justify-between items-center pt-2">
              <button type="submit" disabled={saving} className="bg-blue-600 text-white px-6 py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
                {saving ? 'Saving...' : 'Save changes'}
              </button>
              <button type="button" onClick={handleDelete} className="text-red-500 text-sm hover:text-red-700">
                Delete player
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}