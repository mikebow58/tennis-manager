'use client';

import { useEffect } from 'react';

const formatDateString = (dateStr) => {
  if (!dateStr) return 'Upcoming Session';
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};

/**
 * Builds the format instruction for one court on the printed sheet.
 *
 * Logic:
 *   - Court is in a rotation pairing → session format governs (per-court
 *     partner_setting is ignored). Full text includes winners/losers direction.
 *   - Court is NOT in a rotation pairing → per-court partner_setting governs,
 *     falling back to session format when null.
 *
 * session.format / partner_setting values:
 *   'switch_partners'  → "Switch partners each set"
 *   'paired_rotation'  → "Keep partners each set"
 *   null               → treated as 'paired_rotation' (keep partners)
 */
function buildFormatInstruction(partnerSetting, sessionFormat, rotationRow, getCourtLabel) {
  if (rotationRow) {
    // Rotation pairing — session format governs
    const partnerText = sessionFormat === 'switch_partners'
      ? 'Switch partners each set'
      : 'Keep partners each set';
    const winnersLabel = getCourtLabel(rotationRow.winners_court_letter);
    const secondLabel  = getCourtLabel(rotationRow.second_court_letter);
    return `Winners to ${winnersLabel}, Losers to ${secondLabel} · ${partnerText}`;
  }

  // No rotation — use per-court override, fall back to session format
  const effective = partnerSetting ?? sessionFormat ?? 'paired_rotation';
  return effective === 'switch_partners'
    ? 'Switch partners each set'
    : 'Keep partners each set';
}

export default function PrintSheetClient({ daySessions, locationMap, assignments, rotations, notes }) {

  useEffect(() => {
    const timer = setTimeout(() => { window.print(); }, 400);
    return () => clearTimeout(timer);
  }, []);

  // Map session_id + court_letter → organiser-assigned court_number
  const letterToNumberMap = {};
  assignments.forEach(asg => {
    if (asg.session_id && asg.court_letter && asg.court_number) {
      letterToNumberMap[`${asg.session_id}_${asg.court_letter}`] = asg.court_number;
    }
  });

  const getCourtLabelBySessionAndLetter = (sessionId, letter) => {
    const num = letterToNumberMap[`${sessionId}_${letter}`];
    return num != null ? `Court ${num}` : `Court ${letter}`;
  };

  // Group rosters by session/location
  const groupedData = {};

  daySessions.forEach(session => {
    const locName = locationMap[session.location_id] || 'Club Location';
    const sessionAssignments = assignments.filter(a => a.session_id === session.id);
    if (sessionAssignments.length === 0) return;

    if (!groupedData[session.id]) {
      groupedData[session.id] = {
        locationName: locName,
        sessionDate: session.session_date,
        sessionFormat: session.format ?? null,
        courts: {}
      };
    }

    sessionAssignments.forEach(asg => {
      const cNum = asg.court_number || 'Unassigned';
      if (!groupedData[session.id].courts[cNum]) {
        groupedData[session.id].courts[cNum] = {
          courtNumber: cNum,
          courtLetter: asg.court_letter,
          partnerSetting: asg.partner_setting ?? null,
          teams: { 1: [], 2: [], unpaired: [] },
          formatInstruction: '',
          noteText: ''
        };
      }
      if (asg.players) {
        const fullName = `${asg.players.first_name} ${asg.players.last_name}`;
        const court = groupedData[session.id].courts[cNum];
        if (asg.team_number === 1)      court.teams[1].push(fullName);
        else if (asg.team_number === 2) court.teams[2].push(fullName);
        else                            court.teams.unpaired.push(fullName);
        // Keep the per-court partner_setting from the first row seen for this court
        if (court.partnerSetting == null && asg.partner_setting != null) {
          court.partnerSetting = asg.partner_setting;
        }
      }
    });

    // Weave format instruction and notes onto each court
    Object.keys(groupedData[session.id].courts).forEach(cNum => {
      const court = groupedData[session.id].courts[cNum];

      const rotationRow = rotations.find(r =>
        r.winners_court_letter === court.courtLetter ||
        r.second_court_letter  === court.courtLetter
      ) ?? null;

      court.formatInstruction = buildFormatInstruction(
        court.partnerSetting,
        session.format ?? null,
        rotationRow,
        (letter) => getCourtLabelBySessionAndLetter(session.id, letter)
      );

      const noteRow = notes.find(n => n.court_letter === court.courtLetter);
      if (noteRow) court.noteText = noteRow.note_text ?? noteRow.note ?? '';
    });
  });

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white p-6 print:p-0 font-sans">
      <style dangerouslySetInnerHTML={{__html: `
        @media print {
          @page { margin: 0; }
          body { margin: 0 !important; padding: 0 !important; background: white; width: 100% !important; }
          .print-page-wrapper { padding: 0.6in !important; box-sizing: border-box; }
          nav, header, footer, aside, [role="navigation"], .main-sidebar, .main-navbar { display: none !important; }
        }
      `}} />

      {/* On-screen control bar */}
      <div className="max-w-4xl mx-auto mb-6 p-4 bg-white shadow-sm border rounded-xl flex items-center justify-between print:hidden">
        <h1 className="text-base font-bold text-gray-900">Lineup Print Preview</h1>
        <button onClick={() => window.print()} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm transition-colors">Print</button>
      </div>

      <div className="max-w-4xl mx-auto bg-white print:w-full print:max-w-full">
        {Object.keys(groupedData).map((sessionId, sIdx) => {
          const sessionGroup = groupedData[sessionId];
          const sortedCourts = Object.keys(sessionGroup.courts).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

          return (
            <div key={sessionId} className={`print-page-wrapper ${sIdx > 0 ? 'print:break-before-page mt-12 print:mt-0' : ''}`}>
              {/* Header banner */}
              <div className="mb-6 pb-3 border-b-4 border-gray-900">
                <h1 className="text-2xl print:text-[24pt] font-black text-gray-900 tracking-tight">
                  Lineup for {formatDateString(sessionGroup.sessionDate)} – {sessionGroup.locationName}
                </h1>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 print:grid-cols-2 print:gap-6 print:w-full">
                {sortedCourts.map(cNum => {
                  const court = sessionGroup.courts[cNum];
                  if (cNum === 'Unassigned') return null;

                  return (
                    <div key={cNum} className="border-2 border-gray-400 rounded-xl p-6 print:p-8 flex flex-col justify-between bg-gray-50/30 print:bg-white print:break-inside-avoid print:shadow-none shadow-sm" style={{ minHeight: '12rem' }}>
                      <div>
                        {/* Court title */}
                        <div className="border-b-2 border-gray-800 pb-2 mb-4">
                          <h2 className="text-2xl print:text-3xl font-black text-gray-900 tracking-tight uppercase">
                            Court {court.courtNumber}
                          </h2>
                        </div>

                        {/* Team roster — two stacked pairs with divider between teams */}
                        <div className="space-y-3">
                          {[1, 2].map(teamNum => (
                            court.teams[teamNum].length > 0 && (
                              <ul key={teamNum} className="space-y-1 font-bold text-gray-900">
                                {court.teams[teamNum].map((name, pIdx) => (
                                  <li key={pIdx} className="text-[18pt] leading-tight tracking-wide truncate">{name}</li>
                                ))}
                              </ul>
                            )
                          ))}

                          {/* Divider between the two teams */}
                          {court.teams[1].length > 0 && court.teams[2].length > 0 && (
                            <div className="border-t border-dashed border-gray-300 my-1" />
                          )}

                          {/* Unpaired players (edge case) */}
                          {court.teams.unpaired.length > 0 && (
                            <ul className="space-y-1 font-semibold text-gray-700">
                              {court.teams.unpaired.map((name, pIdx) => (
                                <li key={pIdx} className="text-[14pt] leading-tight tracking-wide truncate">{name}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>

                      {/* Rules & Notes footer — always shown */}
                      <div className="mt-6 pt-4 border-t-2 border-dotted border-gray-300 text-gray-700 space-y-1.5 font-medium">
                        <p className="leading-tight font-extrabold text-gray-900 text-[13pt]">
                          {court.formatInstruction}
                        </p>
                        {court.noteText && (
                          <p className="bg-amber-50/60 print:bg-gray-100/70 p-2 rounded border border-amber-100 print:border-gray-200 italic font-normal leading-snug text-gray-700 text-[13pt]">
                            "{court.noteText}"
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}