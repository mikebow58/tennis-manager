'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter, useParams } from 'next/navigation'
import Select from '@/app/components/Select'
import { getTimeOptions } from '@/lib/utils'

export default function NewSessionPage() {
  const router = useRouter()
  const params = useParams()
  const weekId = params.id
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    session_date: '',
    start_time: '08:00',
    location: '',
    court_count: 2,
    format: 'switch_partners',
    status: 'open',
    notes: '',
  })

  function handleChange(e) {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    const { error } = await supabase
      .from('sessions')
      .insert([{ ...form, week_id: weekId, court_count: Number(form.court_count) }])

    if (error) {
      console.error(error)
      alert('Error saving session.')
      setSaving(false)
      return
    }

    router.push(`/weeks/${weekId}`)
  }

  return (
    <div className="p-8 max-w-lg">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Add session</h1>
        <a href={`/weeks/${weekId}`} className="text-sm text-gray-500 hover:text-gray-700">Cancel</a>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Date</label>
          <input type="date" name="session_date" value={form.session_date} onChange={handleChange} required className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </div>

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

        <div>
          <label className="block text-sm text-gray-600 mb-1">Location</label>
          <input type="text" name="location" value={form.location} onChange={handleChange} required className="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="e.g. Willow Creek Park" />
        </div>

        <div>
          <label className="block text-sm text-gray-600 mb-1">Number of courts</label>
          <input type="number" name="court_count" value={form.court_count} onChange={handleChange} min="1" max="20" required className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </div>

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

        <div>
          <label className="block text-sm text-gray-600 mb-1">Reminder note</label>
          <textarea name="notes" value={form.notes} onChange={handleChange} rows={2} placeholder="e.g. Arrive 10 min early · Bring a can of balls" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </div>

        <div className="pt-2">
          <button type="submit" disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Add session'}
          </button>
        </div>
      </form>
    </div>
  )
}