'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { getSkillLabel } from '@/lib/utils'

function PlayersList() {
  const searchParams = useSearchParams()
  const showInactive = searchParams.get('status') === 'inactive'
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(null)

  useEffect(() => {
    fetchPlayers()
  }, [showInactive])

  async function fetchPlayers() {
    setLoading(true)
    const res = await fetch(`/api/players?active=${!showInactive}`)
    const data = await res.json()
    setPlayers(data)
    setLoading(false)
  }

  async function toggleActive(player) {
    setToggling(player.id)
    await fetch(`/api/players/${player.id}/toggle-active`, { method: 'POST' })
    await fetchPlayers()
    setToggling(null)
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Players</h1>
            <p className="text-xs text-slate-300 mt-0.5">
              {players.length} {showInactive ? 'inactive' : 'active'}
            </p>
          </div>
          <a href="/players/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">Add player</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-4 max-w-6xl mx-auto">

        <div className="flex justify-end mb-3">
          {showInactive ? (
            <a href="/players" className="text-xs text-blue-600 hover:underline">Show active players</a>
          ) : (
            <a href="/players?status=inactive" className="text-xs text-blue-600 hover:underline">Show inactive players</a>
          )}
        </div>

        {/* Mobile view */}
        <div className="md:hidden space-y-2">
          {players.map((player) => (
            <div key={player.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-3">
              <a href={`/players/${player.id}`} className="flex-1">
                <div className="text-sm font-medium text-blue-600">
                  {player.last_name}, {player.first_name}
                </div>
                <div className="text-xs text-gray-500 mt-0.5 capitalize">
                  {player.player_type} · {player.active ? 'Active' : 'Inactive'}
                </div>
              </a>
              <div className="text-right">
                <div className="text-sm font-medium text-gray-800">{getSkillLabel(player.skill_admin)}</div>
                <div className="text-xs text-gray-500">
                  {player.gender === 'M' ? 'Male' : player.gender === 'F' ? 'Female' : player.gender}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop view */}
        <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 bg-gray-50">
                <th className="px-6 py-3">Name</th>
                <th className="px-6 py-3">Mobile</th>
                <th className="px-6 py-3">Email</th>
                <th className="px-6 py-3">Gender</th>
                <th className="px-6 py-3">Skill</th>
                <th className="px-6 py-3">Type</th>
                <th className="px-6 py-3">{showInactive ? 'Activate' : 'Deactivate'}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-6 text-center text-sm text-gray-400">Loading...</td>
                </tr>
              ) : (
                players.map((player) => (
                  <tr key={player.id} className="border-b border-gray-100 text-sm hover:bg-gray-50">
                    <td className="px-6 py-3 font-medium">
                      <a href={`/players/${player.id}`} className="text-blue-600 hover:underline">
                        {player.last_name}, {player.first_name}
                      </a>
                    </td>
                    <td className="px-6 py-3 text-gray-600">{player.mobile}</td>
                    <td className="px-6 py-3 text-gray-600">{player.email}</td>
                    <td className="px-6 py-3 text-gray-600">{player.gender}</td>
                    <td className="px-6 py-3 text-gray-600">{getSkillLabel(player.skill_admin)}</td>
                    <td className="px-6 py-3 text-gray-600 capitalize">{player.player_type}</td>
                    <td className="px-6 py-3">
                      <button
                        onClick={() => toggleActive(player)}
                        disabled={toggling === player.id}
                        className={`text-xs font-medium px-3 py-1 rounded-full transition-colors ${
                          showInactive
                            ? 'text-green-700 bg-green-50 hover:bg-green-100'
                            : 'text-red-600 bg-red-50 hover:bg-red-100'
                        } disabled:opacity-40`}
                      >
                        {toggling === player.id
                          ? '...'
                          : showInactive ? 'Activate' : 'Deactivate'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function PlayersPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f1efe9]" />}>
      <PlayersList />
    </Suspense>
  )
}