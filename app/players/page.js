import { supabase } from '@/lib/supabase'
import { getSkillLabel } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function PlayersPage() {
  const { data: players, error } = await supabase
    .from('players')
    .select('*')
    .order('last_name', { ascending: true })

  if (error) {
    console.error(error)
    return <div>Error loading players.</div>
  }

  return (
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Players</h1>
            <p className="text-xs text-slate-300 mt-0.5">{players.length} active</p>
          </div>
          <a href="/players/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">Add player</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-4 max-w-5xl mx-auto">
        <div className="md:hidden space-y-2">
          {players.map((player) => (
            <a key={player.id} href={`/players/${player.id}`} className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-3 hover:bg-gray-50">
              <div>
                <div className="text-sm font-medium text-blue-600">
                  {player.last_name}, {player.first_name}
                </div>
                <div className="text-xs text-gray-500 mt-0.5 capitalize">
                  {player.player_type} · {player.active ? 'Active' : 'Inactive'}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium text-gray-800">{getSkillLabel(player.skill_admin)}</div>
                <div className="text-xs text-gray-500">
                  {player.gender === 'M' ? 'Male' : player.gender === 'F' ? 'Female' : player.gender}
                </div>
              </div>
            </a>
          ))}
        </div>

        <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 bg-gray-50">
                <th className="px-6 py-3">Name</th>
                <th className="px-6 py-3">Mobile</th>
                <th className="px-6 py-3">Gender</th>
                <th className="px-6 py-3">Skill</th>
                <th className="px-6 py-3">Type</th>
                <th className="px-6 py-3">Active</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player) => (
                <tr key={player.id} className="border-b border-gray-100 text-sm hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium">
                    <a href={`/players/${player.id}`} className="text-blue-600 hover:underline">
                      {player.last_name}, {player.first_name}
                    </a>
                  </td>
                  <td className="px-6 py-3 text-gray-600">{player.mobile}</td>
                  <td className="px-6 py-3 text-gray-600">{player.gender}</td>
                  <td className="px-6 py-3 text-gray-600">{getSkillLabel(player.skill_admin)}</td>
                  <td className="px-6 py-3 text-gray-600 capitalize">{player.player_type}</td>
                  <td className="px-6 py-3 text-gray-600">{player.active ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}