import { supabase } from '@/lib/supabase'

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
    <div className="p-4 md:p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl md:text-2xl font-semibold">Players</h1>
        <a href="/players/new" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">Add player</a>
      </div>

      <div className="md:hidden space-y-2">
        {players.map((player) => (
          <a key={player.id} href={`/players/${player.id}`} className="flex items-center justify-between p-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
            <div>
              <div className="font-medium text-sm text-gray-900">{player.first_name} {player.last_name}</div>
              <div className="text-xs text-gray-500 mt-0.5 capitalize">{player.player_type} · {player.active ? 'Active' : 'Inactive'}</div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">{player.gender}</span>
              <span className="text-sm font-medium text-gray-700">{player.skill_admin ?? '—'}</span>
              <span className="text-gray-400 text-sm">›</span>
            </div>
          </a>
        ))}
      </div>

      <div className="hidden md:block overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-left text-sm text-gray-500">
              <th className="pb-3 pr-6">Name</th>
              <th className="pb-3 pr-6">Mobile</th>
              <th className="pb-3 pr-6">Gender</th>
              <th className="pb-3 pr-6">Skill</th>
              <th className="pb-3 pr-6">Type</th>
              <th className="pb-3">Active</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player) => (
              <tr key={player.id} className="border-b border-gray-100 text-sm hover:bg-gray-50">
                <td className="py-3 pr-6 font-medium">
                  <a href={`/players/${player.id}`} className="text-blue-600 hover:underline">
                    {player.first_name} {player.last_name}
                  </a>
                </td>
                <td className="py-3 pr-6 text-gray-600">{player.mobile}</td>
                <td className="py-3 pr-6 text-gray-600">{player.gender}</td>
                <td className="py-3 pr-6 text-gray-600">{player.skill_admin}</td>
                <td className="py-3 pr-6 text-gray-600 capitalize">{player.player_type}</td>
                <td className="py-3 text-gray-600">{player.active ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}