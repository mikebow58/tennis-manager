'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter, useParams } from 'next/navigation'

export default function AddPlayerToSessionPage() {
  const router = useRouter()
  const params = useParams()
  const { id, sessionId } = params

  const [players, setPlayers] = useState([])
  const [alreadyAdded, setAlreadyAdded] = useState([])
  const [saving, setSaving] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: allPlayers } = await supabase
        .from('players')
        .select('id, first_name, last_name, gender, skill_admin, player_type')
        .eq('active', true)
        .order('last_name', { ascending: true })

      const { data: existing } = await supabase
        .from('availability')
        .select('player_id')
        .eq('session_id', sessionId)

      const existingIds = existing.map(e => e.player_id)
      setAlreadyAdded(existingIds)
      setPlayers(allPlayers || [])
      setLoading(false)
    }

    load()
  }, [sessionId])

  async function addPlayer(playerId) {
    setSaving(playerId)

    const { error } = await supabase
      .from('availability')
      .insert([{ session_id: sessionId, player_id: playerId, status: 'confirmed' }])

    if (error) {
      console.error(error)
      alert('Error adding player.')
      setSaving(null)
      return
    }

    setAlreadyAdded(prev => [...prev, playerId])
    setSaving(null)
  }

  async function removePlayer(playerId) {
    setSaving(playerId)

    const { error } = await supabase
      .from('availability')
      .delete()
      .eq('session_id', sessionId)
      .eq('player_id', playerId)

    if (error) {
      console.error(error)
      alert('Error removing player.')
      setSaving(null)
      return
    }

    setAlreadyAdded(prev => prev.filter(id => id !== playerId))
    setSaving(null)
  }

  if (loading) {
    return <div className="p-8 text-gray-500">Loading players...</div>
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Add players</h1>
        <a href={`/weeks/${id}/sessions/${sessionId}`} className="text-sm text-gray-500 hover:text-gray-700">Done</a>
      </div>

      <p className="text-sm text-gray-500 mb-6">
        {alreadyAdded.length} player{alreadyAdded.length !== 1 ? 's' : ''} added to this session
      </p>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-gray-200 text-left text-sm text-gray-500">
            <th className="pb-3 pr-6">Name</th>
            <th className="pb-3 pr-6">Gender</th>
            <th className="pb-3 pr-6">Skill</th>
            <th className="pb-3 pr-6">Type</th>
            <th className="pb-3"></th>
          </tr>
        </thead>
        <tbody>
          {players.map((player) => {
            const isAdded = alreadyAdded.includes(player.id)
            const isSaving = saving === player.id
            return (
              <tr key={player.id} className={`border-b border-gray-100 text-sm ${isAdded ? 'bg-green-50' : 'hover:bg-gray-50'}`}>
                <td className="py-3 pr-6 font-medium">
                  {player.first_name} {player.last_name}
                </td>
                <td className="py-3 pr-6 text-gray-600">{player.gender}</td>
                <td className="py-3 pr-6 text-gray-600">{player.skill_admin}</td>
                <td className="py-3 pr-6 text-gray-600 capitalize">{player.player_type}</td>
                <td className="py-3">
                  {isAdded ? (
                    <button
                      onClick={() => removePlayer(player.id)}
                      disabled={isSaving}
                      className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                    >
                      {isSaving ? 'Removing...' : 'Remove'}
                    </button>
                  ) : (
                    <button
                      onClick={() => addPlayer(player.id)}
                      disabled={isSaving}
                      className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                    >
                      {isSaving ? 'Adding...' : 'Add'}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}