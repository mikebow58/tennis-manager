import { supabase } from '@/lib/supabase'

export default async function Home() {
  const { data: players, error } = await supabase
    .from('players')
    .select('*')

  if (error) {
    console.error(error)
    return <div>Error loading players.</div>
  }

  return (
    <div>
      <h1>Tennis Manager</h1>
      <p>Players in database: {players.length}</p>
      <ul>
        {players.map((player) => (
          <li key={player.id}>
            {player.first_name} {player.last_name}
          </li>
        ))}
      </ul>
    </div>
  )
}