import { supabaseAdmin as supabase } from '@/lib/supabase-admin'

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
    <div className="min-h-screen bg-[#f1efe9]">
      <div className="bg-[#0f172a] px-4 md:px-8 py-5">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-white">Weeks</h1>
            <p className="text-xs text-slate-300 mt-0.5">{weeks.length} total</p>
          </div>
          <a href="/weeks/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">New week</a>
        </div>
      </div>

      <div className="px-4 md:px-8 py-4 max-w-3xl mx-auto">
        {weeks.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-8 text-center text-sm text-gray-400">
            No weeks yet. Create your first week to get started.
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            {weeks.map((week, index) => {
  const start = new Date(week.start_date + 'T00:00:00')
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const isCompleted = end < today

  return (
    <a key={week.id} href={`/weeks/${week.id}`} className={`flex items-center justify-between px-4 py-3 hover:bg-gray-50 ${index !== weeks.length - 1 ? 'border-b border-gray-100' : ''}`}>
      <div>
        <div className={`text-sm font-medium ${isCompleted ? 'text-gray-400' : 'text-blue-600'}`}>
          {new Date(week.start_date).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC'
          })}
        </div>
        <div className="text-xs text-gray-500 mt-0.5 capitalize">
          {isCompleted ? 'Completed' : week.status}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isCompleted && (
          <span className="text-xs bg-gray-100 text-gray-400 px-2 py-0.5 rounded-full">Completed</span>
        )}
        <span className="text-gray-400 text-sm">›</span>
      </div>
    </a>
  )
})}
          </div>
        )}
      </div>
    </div>
  )
}