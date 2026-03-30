'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function CancelForm({ playerId, playerName, sessionId, availabilityId }) {
  const [cancelling, setCancelling] = useState(false)
  const [cancelled, setCancelled] = useState(false)

  async function handleCancel() {
    setCancelling(true)

    const { error } = await supabase
      .from('availability')
      .delete()
      .eq('id', availabilityId)

    if (error) {
      console.error(error)
      alert('Something went wrong. Please try again.')
      setCancelling(false)
      return
    }

    setCancelled(true)
  }

  if (cancelled) {
    return (
      <div className="text-center py-8">
        <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M5 13l4 4L19 7" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h2 className="text-lg font-medium text-gray-900 mb-2">Cancelled</h2>
        <p className="text-sm text-gray-500">
          Your spot for this session has been cancelled. The organizer has been notified.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <button
        onClick={handleCancel}
        disabled={cancelling}
        className="w-full bg-red-500 text-white py-3 rounded-lg font-medium hover:bg-red-600 disabled:opacity-50"
      >
        {cancelling ? 'Cancelling...' : 'Yes, cancel my spot'}
      </button>
      <button
        onClick={() => window.history.back()}
        className="w-full bg-white border border-gray-200 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50"
      >
        Keep my spot
      </button>
    </div>
  )
}