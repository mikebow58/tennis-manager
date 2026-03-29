'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function SignupForm({ player, sessions, signedUpSessionIds }) {
  const [selected, setSelected] = useState(signedUpSessionIds)
  const [saving, setSaving] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  function toggleSession(sessionId) {
    setSelected(prev =>
      prev.includes(sessionId)
        ? prev.filter(id => id !== sessionId)
        : [...prev, sessionId]
    )
  }

  async function handleConfirm() {
    setSaving(true)

    const toAdd = selected.filter(id => !signedUpSessionIds.includes(id))
    const toRemove = signedUpSessionIds.filter(id => !selected.includes(id))

    if (toRemove.length > 0) {
      await supabase
        .from('availability')
        .delete()
        .eq('player_id', player.id)
        .in('session_id', toRemove)
    }

    if (toAdd.length > 0) {
      await supabase
        .from('availability')
        .insert(toAdd.map(sessionId => ({
          session_id: sessionId,
          player_id: player.id,
          status: 'confirmed'
        })))
    }

    setSaving(false)
    setConfirmed(true)
  }

  if (confirmed) {
    return (
      <div className="text-center py-8">
        <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M5 13l4 4L19 7" stroke="#15803d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h2 className="text-lg font-medium text-gray-900 mb-2">You're all set, {player.first_name}!</h2>
        <p className="text-sm text-gray-500 mb-6">
          {selected.length === 0
            ? "You're not signed up for any days this week."
            : `Signed up for ${selected.length} day${selected.length !== 1 ? 's' : ''} this week.`}
        </p>
        <button
          onClick={() => setConfirmed(false)}
          className="text-sm text-blue-600 hover:underline"
        >
          Need to change your days?
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="space-y-2 mb-8">
        {sessions.length === 0 ? (
          <p className="text-gray-500 text-sm">No sessions are open for signup right now.</p>
        ) : (
          sessions.map((session) => {
            const isSelected = selected.includes(session.id)
            const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC'
            })

            return (
              <div
                key={session.id}
                onClick={() => toggleSession(session.id)}
                className={`flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-green-50 border-green-300'
                    : 'bg-white border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div>
                  <div className={`font-medium text-sm ${isSelected ? 'text-green-800' : 'text-gray-900'}`}>
                    {dateLabel}
                  </div>
                  <div className={`text-xs mt-0.5 ${isSelected ? 'text-green-600' : 'text-gray-400'}`}>
                    {session.start_time} · {session.location}
                  </div>
                </div>
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  isSelected ? 'bg-green-500 border-green-500' : 'border-gray-300'
                }`}>
                  {isSelected && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      <button
        onClick={handleConfirm}
        disabled={saving}
        className="w-full bg-green-600 text-white py-3 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Confirm signup'}
      </button>
    </div>
  )
}