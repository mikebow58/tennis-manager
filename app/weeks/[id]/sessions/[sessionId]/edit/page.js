'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter, useParams } from 'next/navigation'
import Select from '@/app/components/Select'
import { getTimeOptions } from '@/lib/utils'

export default function EditSessionPage() {
  const router = useRouter()
  const params = useParams()
  const { id, sessionId } = params
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    session_date: '',
    start_time: '',
    location: '',
    court_count: 2,
    format: 'switch_partners',
    status: 'open',
    notes: '',
  })

  useEffect(() => {
    async function loadSession() {
      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .single()

      if (error) {
        console.error(error)
        return
      }

      setForm({
        session_date: data.session_date || '',
        start_time: data.start_time || '',
        location: data.location || '',
        court_count: data.court_count || 2,
        format: data.format || 'switch_partners',
        status: data.status || 'open',
        notes: data.notes || '',
      })
      setLoading(false)
    }

    loadSession()
  }, [sessionId])

  function handleChange(e) {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    const { error } = await supabase
      .from('sessions')
      .update({ ...form, court_count: Number(form.court_count) })
      .eq('id', sessionId)

    if (error) {
      console.error(error)
      alert('Error saving session.')
      setSaving(false)
      return
    }

    router.push(`/weeks/${id}/sessions/${sessionId}`)
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      'Are you sure you want to delete this session? This will also remove all player signups for this day.'
    )
    if (!confirmed) return

    await supabase
      .from('availability')
      .delete()
      .eq('session_id', sessionId)

    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', sessionId)

    if (error) {
      console.error(error)
      alert('Error deleting session.')
      return
    }

    router.push(`/weeks/${id}`)
  }

  if (loading) {
    return <div className="min-h-screen bg-[#f1efe9] flex items-center justify-center text-gray-500 text-sm">Loading...</div>
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-lg mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Edit session</h1>
            <p className="text-xs text-slate-300 mt-0.5">Update session details</p>
          </div>
          <a href={`/weeks/${id}/sessions/${sessionId}`} className="text-xs text-slate-300 hover:text-white">Cancel</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6 max-w-lg mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Date</label>
              <input type="date" name="session_date" value={form.session_date} onChange={handleChange} required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Start time</label>
              <Select name="start_time" value={form.start_time} onChange={handleChange} options={getTimeOptions()} placeholder="Select time..." />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Location</label>
              <input type="text" name="location" value={form.location} onChange={handleChange} required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Number of courts</label>
              <input type="number" name="court_count" value={form.court_count} onChange={handleChange} min="1" max="20" required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Play format</label>
              <Select name="format" value={form.format} onChange={handleChange} options={[
                { value: 'switch_partners', label: 'Switch partners' },
                { value: 'keep_partners', label: 'Keep partners' },
              ]} />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Status</label>
              <Select name="status" value={form.status} onChange={handleChange} options={[
                { value: 'open', label: 'Open' },
                { value: 'full', label: 'Full' },
                { value: 'cancelled', label: 'Cancelled' },
              ]} />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Reminder note</label>
              <textarea name="notes" value={form.notes} onChange={handleChange} rows={2} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="flex justify-between items-center pt-2">
              <button type="submit" disabled={saving} className="bg-blue-600 text-white px-6 py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
                {saving ? 'Saving...' : 'Save changes'}
              </button>
              <button type="button" onClick={handleDelete} className="text-red-500 text-sm hover:text-red-700">
                Delete session
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}