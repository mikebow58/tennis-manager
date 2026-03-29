'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

export default function NewWeekPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [startDate, setStartDate] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    const { data: week, error } = await supabase
      .from('weeks')
      .insert([{ start_date: startDate, status: 'open' }])
      .select()
      .single()

    if (error) {
      console.error(error)
      alert('Error creating week.')
      setSaving(false)
      return
    }

    router.push(`/weeks/${week.id}`)
  }

  return (
    <div className="p-8 max-w-md">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">New week</h1>
        <a href="/weeks" className="text-sm text-gray-500 hover:text-gray-700">Cancel</a>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">
            Week start date (Monday)
          </label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
          <p className="text-xs text-gray-400 mt-1">Select the Monday this week begins on</p>
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Creating...' : 'Create week'}
          </button>
        </div>
      </form>
    </div>
  )
}