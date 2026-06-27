/**
 * app/admin/court-assignment/[sessionId]/print/page.js
 * Full replacement — adds partner_setting to court_assignments select.
 */

import { createClient } from '@/lib/supabase-server'
import PrintSheetClient from './PrintSheetClient';

export const dynamic = 'force-dynamic';

export default async function PrintLineupPage(props) {
  try {
    const resolvedParams = props?.params ? await props.params : {};
    const sessionId = resolvedParams?.sessionId;

    if (!sessionId) {
      return <div style={{ padding: '20px', color: '#dc2626', fontFamily: 'sans-serif' }}>Error: No sessionId found in route parameters.</div>;
    }

    const supabase = await createClient();
    if (!supabase) {
      return <div style={{ padding: '20px', color: '#dc2626', fontFamily: 'sans-serif' }}>Error: Supabase client failed to initialize.</div>;
    }

    const { data: anchorSession, error: anchorError } = await supabase
      .from('sessions').select('*').eq('id', sessionId).single();

    if (anchorError || !anchorSession) {
      return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
          <h3 style={{ color: '#dc2626' }}>Database Fetch Failure (Anchor Session)</h3>
          <p>Session ID requested: <strong>{sessionId}</strong></p>
          <pre style={{ background: '#f3f4f6', padding: '12px', borderRadius: '6px', fontSize: '13px' }}>{JSON.stringify(anchorError, null, 2)}</pre>
        </div>
      );
    }

    const isSent = anchorSession.court_assignment_sent_at || anchorSession.court_assignment_notified_at;
    if (!isSent) {
      return (
        <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'sans-serif' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', color: '#1f2937' }}>Lineup Sheet Locked</h1>
          <p style={{ color: '#4b5563', maxWidth: '500px', margin: '0 auto', lineHeight: '1.5' }}>
            These court assignments have not been finalized yet. Please approve the session layout before printing.
          </p>
        </div>
      );
    }

    const { week_id, session_date } = anchorSession;

    const { data: daySessions } = await supabase
      .from('sessions')
      .select('id, location_id, format, session_date')
      .eq('week_id', week_id)
      .eq('session_date', session_date);

    const sessionIds = daySessions?.map(s => s.id) || [sessionId];

    const { data: locations } = await supabase.from('locations').select('id, name');
    const locationMap = Object.fromEntries(locations?.map(l => [l.id, l.name]) || []);

    // partner_setting added — per-court partner behaviour override
    const { data: assignments, error: assignmentsError } = await supabase
      .from('court_assignments')
      .select(`
        id, session_id, player_id,
        court_number, court_letter, team_number, partner_setting,
        players ( id, first_name, last_name )
      `)
      .in('session_id', sessionIds);

    if (assignmentsError) {
      return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
          <h3 style={{ color: '#dc2626' }}>Database Fetch Failure (Court Assignments)</h3>
          <pre style={{ background: '#f3f4f6', padding: '12px', borderRadius: '6px', fontSize: '13px' }}>{JSON.stringify(assignmentsError, null, 2)}</pre>
        </div>
      );
    }

    const { data: rotations } = await supabase
      .from('court_rotations').select('*').eq('week_id', week_id).eq('session_date', session_date);

    const { data: notes } = await supabase
      .from('court_notes').select('*').eq('week_id', week_id).eq('session_date', session_date);

    return (
      <PrintSheetClient
        daySessions={daySessions || []}
        locationMap={locationMap}
        assignments={assignments || []}
        rotations={rotations || []}
        notes={notes || []}
      />
    );

  } catch (err) {
    return (
      <div style={{ padding: '30px', fontFamily: 'monospace', border: '2px solid #dc2626', margin: '20px', borderRadius: '8px', background: '#fef2f2' }}>
        <h2 style={{ color: '#b91c1c', marginTop: 0 }}>Server Runtime Exception</h2>
        <p><strong>Error:</strong> {err.message}</p>
        <pre style={{ background: '#fff', padding: '15px', border: '1px solid #fee2e2', overflowX: 'auto', borderRadius: '4px', fontSize: '12px', color: '#374151' }}>{err.stack}</pre>
      </div>
    );
  }
}