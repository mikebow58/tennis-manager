'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

export default function RemovePlayerButton({ availabilityId, playerName }) {
  const router = useRouter()
  const [removing, setRemoving] = useState(false)

  async function handleRemove() {
    const confirmed = window.confirm(`Remove ${playerName} from this session?`)
    if (!confirmed) return

    setRemoving(true)

    const { error } = await supabase
      .from('availability')
      .delete()
      .eq('id', availabilityId)

    if (error) {
      console.error(error)
      alert('Error removing player.')
      setRemoving(false)
      return
    }

    router.refresh()
  }

  return (
    <button
      onClick={handleRemove}
      disabled={removing}
      className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
    >
      {removing ? 'Removing...' : 'Remove'}
    </button>
  )
}