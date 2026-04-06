'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { getSkillLabel } from '@/lib/utils'

export default function AddPlayerClient({ weekId, sessionId, allPlayers, initialExistingIds }) {
  const [alreadyAdded, setAlreadyAdded] = useState(initialExistingIds)
  const [saving, setSaving] = useState(null)
  const [added, setAdded] = useState({}) // tracks names for confirmation flash
  const [search, setSearch] = useState('')

  async function addPlayer(player) {
    setSaving(player.id)

    const { error } = await supabase
      .from('availability')
      .insert([{ session_id: sessionId, player_id: player.id, status: 'confirmed' }])

    if (error) {
      console.error(error)
      alert('Error adding player.')
      setSaving(null)
      return
    }

    setAlreadyAdded(prev => [...prev, player.id])
    setAdded(prev => ({ ...prev, [player.id]: true }))
    setSaving(null)
  }

  const availablePlayers = allPlayers.filter(p => {
    if (alreadyAdded.includes(p.id)) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      p.first_name.toLowerCase().includes(q) ||
      p.last_name.toLowerCase().includes(q)
    )
  })

  const addedCount = alreadyAdded.length

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Add player</h1>
            <p className="text-xs text-slate-300 mt-0.5">
              {addedCount} player{addedCount !== 1 ? 's' : ''} already in this session
            </p>
          </div>
          <a href={`/weeks/${weekId}/sessions/${sessionId}`} className="text-xs text-slate-300 hover:text-white">
            Done
          </a>
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
            autoFocus
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
                <div
                  key={player.id}
                  className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-3 gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {player.last_name}, {player.first_name}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {getSkillLabel(player.skill_admin)} · {player.gender === 'M' ? 'M' : player.gender === 'F' ? 'F' : player.gender} · <span className="capitalize">{player.player_type}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => addPlayer(player)}
                    disabled={isSaving}
                    className="text-sm font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 flex-shrink-0 min-w-[36px] text-right"
                  >
                    {isSaving ? '…' : 'Add'}
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