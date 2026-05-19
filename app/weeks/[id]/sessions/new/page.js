/**
 * /weeks/[id]/sessions/new
 *
 * Server component: fetches active locations and passes them to the
 * client form component. Matches the pattern used on the edit session
 * and approve week pages.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import NewSessionClient from './NewSessionClient'

export const dynamic = 'force-dynamic'

export default async function NewSessionPage({ params }) {
  const { id } = await params

  const { data: locations, error } = await supabaseAdmin
    .from('locations')
    .select('id, name')
    .eq('active', true)
    .order('name', { ascending: true })

  if (error) {
    console.error('[new session] Locations fetch error:', error)
  }

  return (
    <NewSessionClient
      weekId={id}
      locations={locations || []}
    />
  )
}