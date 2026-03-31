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
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Players</h1>
        
         <a href="/players/new"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Add player
        </a>
      </div>

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
            <tr
              key={player.id}
              className="border-b border-gray-100 text-sm hover:bg-gray-50"
            >
              <td className="py-3 pr-6 font-medium">
  <a href={`/players/${player.id}`} className="hover:underline text-blue-600">
    {player.first_name} {player.last_name}
  </a>
</td>
              <td className="py-3 pr-6 text-gray-600">{player.mobile}</td>
              <td className="py-3 pr-6 text-gray-600">{player.gender}</td>
              <td className="py-3 pr-6 text-gray-600">{player.skill_admin}</td>
              <td className="py-3 pr-6 text-gray-600">{player.player_type}</td>
              <td className="py-3 text-gray-600">
                {player.active ? 'Yes' : 'No'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}