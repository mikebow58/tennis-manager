'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useParams } from 'next/navigation'

export default function AddPlayerToSessionPage() {
  const params = useParams()
  const { id, sessionId } = params

  const [players, setPlayers] = useState([])
  const [alreadyAdded, setAlreadyAdded] = useState([])
  const [saving, setSaving] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

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

  const availablePlayers = players.filter(p => {
    if (alreadyAdded.includes(p.id)) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      p.first_name.toLowerCase().includes(q) ||
      p.last_name.toLowerCase().includes(q)
    )
  })

  if (loading) {
    return <div className="p-8 text-gray-500">Loading players...</div>
  }

  return (
    <div className="p-4 md:p-8 max-w-2xl">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-semibold">Add player</h1>
        <a href={`/weeks/${id}/sessions/${sessionId}`} className="text-sm text-gray-500 hover:text-gray-700">Done</a>
      </div>

      <p className="text-sm text-gray-500 mb-4">
        {alreadyAdded.length} player{alreadyAdded.length !== 1 ? 's' : ''} already in this session
      </p>

      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm"
          autoComplete="off"
        />
      </div>

      {availablePlayers.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center">
          {search ? 'No players match your search.' : 'All active players are already in this session.'}
        </p>
      ) : (
        <div className="space-y-2">
          {availablePlayers.map((player) => {
            const isSaving = saving === player.id
            return (
              <div key={player.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    {player.first_name} {player.last_name}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {player.skill_admin ?? '—'} · {player.gender === 'M' ? 'Male' : player.gender === 'F' ? 'Female' : player.gender} · <span className="capitalize">{player.player_type}</span>
                  </div>
                </div>
                <button
                  onClick={() => addPlayer(player.id)}
                  disabled={isSaving}
                  className="text-sm font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 ml-4"
                >
                  {isSaving ? 'Adding...' : 'Add'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}