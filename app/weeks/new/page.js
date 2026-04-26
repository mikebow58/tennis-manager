'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function NewWeekPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [startDate, setStartDate] = useState('')

  async function handleSubmit(e) {
  e.preventDefault()
  setSaving(true)

  const res = await fetch('/api/weeks/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: startDate, status: 'open' })
  })

  if (!res.ok) {
    alert('Error creating week.')
    setSaving(false)
    return
  }

  const week = await res.json()
  router.push(`/weeks/${week.id}`)
}

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-lg mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">New week</h1>
            <p className="text-xs text-slate-300 mt-0.5">Set the week start date</p>
          </div>
          <a href="/weeks" className="text-xs text-slate-300 hover:text-white">Cancel</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-lg mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Week start date (Monday)</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">Select the Monday this week begins on</p>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              {saving ? 'Creating...' : 'Create week'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}