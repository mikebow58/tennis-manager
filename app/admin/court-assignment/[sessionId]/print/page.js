import { createClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers';
import PrintSheetClient from './PrintSheetClient';

export const dynamic = 'force-dynamic';

// 1. Accept props instead of direct destructuring to allow async parameter resolution
export default async function PrintLineupPage(props) {
  // 2. Await the params promise safely
  const params = await props.params;
  const { sessionId } = params;
  
  // 3. FIX: Use your actual imported createClient() helper here
  const supabase = createClient();

  // 1. Fetch anchor session to verify status and retrieve day-level anchors
  const { data: anchorSession, error: anchorError } = await supabase
    .from('sessions')
    .select('week_id, session_date, court_assignment_sent_at')
    .eq('id', sessionId)
    .single();

  if (anchorError || !anchorSession) {
    return <div className="p-8 text-red-600">Session records not found.</div>;
  }

  // Idempotency Gate: Enforce that lineups cannot be printed until officially approved/sent
  if (!anchorSession.court_assignment_sent_at) {
    return (
      <div className="p-12 text-center max-w-xl mx-auto mt-20 bg-white border rounded-xl shadow-sm">
        <h1 className="text-xl font-black text-gray-800 uppercase tracking-tight">Lineup Sheet Locked</h1>
        <p className="text-gray-600 mt-2">These court assignments have not been finalized or published yet. Please approve the session layout before printing.</p>
      </div>
    );
  }

  const { week_id, session_date } = anchorSession;

  // 2. Fetch all sibling sessions for this day (handles cross-location setups)
  const { data: daySessions } = await supabase
    .from('sessions')
    .select('id, location_id')
    .eq('week_id', week_id)
    .eq('session_date', session_date);

  const sessionIds = daySessions?.map(s => s.id) || [];

  // 3. Pull lookups for location titles
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name');
  const locationMap = Object.fromEntries(locations?.map(l => [l.id, l.name]) || []);

  // 4. Gather all finalized player assignments for the day
  const { data: assignments } = await supabase
    .from('court_assignments')
    .select(`
      id,
      session_id,
      player_id,
      court_number,
      court_letter,
      players ( id, first_name, last_name )
    `)
    .in('session_id', sessionIds);

  // 5. Gather day-scoped rotations and customized court notes
  const { data: rotations } = await supabase
    .from('court_rotations')
    .select('*')
    .eq('week_id', week_id)
    .eq('session_date', session_date);

  const { data: notes } = await supabase
    .from('court_notes')
    .select('*')
    .eq('week_id', week_id)
    .eq('session_date', session_date);

  return (
    <PrintSheetClient 
      daySessions={daySessions || []}
      locationMap={locationMap}
      assignments={assignments || []}
      rotations={rotations || []}
      notes={notes || []}
    />
  );
}