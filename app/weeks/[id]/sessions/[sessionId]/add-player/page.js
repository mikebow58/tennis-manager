'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useParams } from 'next/navigation'
import { getSkillLabel } from '@/lib/utils'

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
        .neq('status', 'cancelled')

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
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Add player</h1>
            <p className="text-xs text-slate-300 mt-0.5">
              {alreadyAdded.length} player{alreadyAdded.length !== 1 ? 's' : ''} already in this session
            </p>
          </div>
          <a href={`/weeks/${id}/sessions/${sessionId}`} className="text-xs text-slate-300 hover:text-white">Done</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-4 max-w-2xl mx-auto">
        <div className="mb-4">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name..."
            className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm bg-white"
            autoComplete="off"
          />
        </div>

        {availablePlayers.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-8 text-center text-sm text-gray-400">
            {search ? 'No players match your search.' : 'All active players are already in this session.'}
          </div>
        ) : (
          <div className="space-y-2">
            {availablePlayers.map((player) => {
              const isSaving = saving === player.id
              return (
                <div key={player.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-3 gap-2">
  <div className="min-w-0 flex-1">
    <div className="text-sm font-medium text-gray-900 truncate">
      {player.last_name}, {player.first_name}
    </div>
    <div className="text-xs text-gray-500 mt-0.5">
      {getSkillLabel(player.skill_admin)} · {player.gender === 'M' ? 'M' : player.gender === 'F' ? 'F' : player.gender} · <span className="capitalize">{player.player_type}</span>
    </div>
  </div>
  <button
    onClick={() => addPlayer(player.id)}
    disabled={isSaving}
    className="text-sm font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 flex-shrink-0"
  >
    {isSaving ? '...' : 'Add'}
  </button>
</div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}