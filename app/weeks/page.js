import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export default async function WeeksPage() {
  const { data: weeks, error } = await supabase
    .from('weeks')
    .select('*')
    .order('start_date', { ascending: false })

  if (error) {
    console.error(error)
    return <div>Error loading weeks.</div>
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Weeks</h1>
        <a href="/weeks/new" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">New week</a>
      </div>

      {weeks.length === 0 ? (
        <p className="text-gray-500">No weeks yet. Create your first week to get started.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-left text-sm text-gray-500">
              <th className="pb-3 pr-6">Week of</th>
              <th className="pb-3 pr-6">Status</th>
              <th className="pb-3">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week.id} className="border-b border-gray-100 text-sm hover:bg-gray-50">
                <td className="py-3 pr-6 font-medium">
                  <a href={`/weeks/${week.id}`} className="text-blue-600 hover:underline">
                    {new Date(week.start_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                  </a>
                </td>
                <td className="py-3 pr-6 text-gray-600 capitalize">{week.status}</td>
                <td className="py-3 text-gray-600">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}