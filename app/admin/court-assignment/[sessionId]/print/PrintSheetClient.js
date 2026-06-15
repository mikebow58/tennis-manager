'use client';

import { useEffect } from 'react';

export default function PrintSheetClient({ daySessions, locationMap, assignments, rotations, notes }) {
  
  // Automatically pop the system print prompt once the layout has fully mounted
  useEffect(() => {
    const timer = setTimeout(() => {
      window.print();
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  // Map session_id + court_letter to the physical organizer-assigned court_number
  const letterToNumberMap = {};
  assignments.forEach(asg => {
    if (asg.session_id && asg.court_letter && asg.court_number) {
      letterToNumberMap[`${asg.session_id}_${asg.court_letter}`] = asg.court_number;
    }
  });

  const getCourtNumber = (sessionId, letter) => {
    return letterToNumberMap[`${sessionId}_${letter}`] || `Court ${letter}`;
  };

  // Group rosters systematically by session/location to protect multi-location days
  const groupedData = {};

  daySessions.forEach(session => {
    const locName = locationMap[session.location_id] || 'Club Location';
    const sessionAssignments = assignments.filter(a => a.session_id === session.id);
    
    if (sessionAssignments.length === 0) return;

    if (!groupedData[session.id]) {
      groupedData[session.id] = {
        locationName: locName,
        courts: {}
      };
    }

    sessionAssignments.forEach(asg => {
      const cNum = asg.court_number || 'Unassigned';
      if (!groupedData[session.id].courts[cNum]) {
        groupedData[session.id].courts[cNum] = {
          courtNumber: cNum,
          courtLetter: asg.court_letter,
          players: [],
          rotationText: '',
          noteText: ''
        };
      }
      if (asg.players) {
        groupedData[session.id].courts[cNum].players.push(
          `${asg.players.first_name} ${asg.players.last_name}`
        );
      }
    });

    // Weave context rules onto matching courts
    Object.keys(groupedData[session.id].courts).forEach(cNum => {
      const court = groupedData[session.id].courts[cNum];
      
      const rotationRow = rotations.find(r => r.court_letter === court.courtLetter);
      if (rotationRow) {
        const winNum = getCourtNumber(session.id, rotationRow.winners_court_letter);
        const secNum = getCourtNumber(session.id, rotationRow.second_court_letter);
        const actionType = rotationRow.rotation_type === 'keep_partners' ? 'Keep same partners' : 'Split & spin';
        
        court.rotationText = `Winners to Crt ${winNum}, Losers to Crt ${secNum} (${actionType})`;
      }

      const noteRow = notes.find(n => n.court_letter === court.courtLetter);
      if (noteRow) {
        court.noteText = noteRow.note_text;
      }
    });
  });

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white p-6 print:p-0 font-sans">
      {/* Top Banner Control - Completely vanished on physical paper via print:hidden */}
      <div className="max-w-4xl mx-auto mb-6 p-4 bg-white shadow-sm border rounded-xl flex items-center justify-between print:hidden">
        <div>
          <h1 className="text-base font-bold text-gray-900">Lineup Print Preview</h1>
          <p className="text-xs text-gray-500">Formats names to exactly 18pt for high visibility on clipboards/fences.</p>
        </div>
        <button
          onClick={() => window.print()}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm transition-colors"
        >
          Trigger Print Dialog
        </button>
      </div>

      {/* Main Container */}
      <div className="max-w-4xl mx-auto bg-white print:w-full">
        {Object.keys(groupedData).map((sessionId, sIdx) => {
          const sessionGroup = groupedData[sessionId];
          const sortedCourts = Object.keys(sessionGroup.courts).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

          return (
            <div key={sessionId} className={sIdx > 0 ? 'print:break-before-page mt-12 print:mt-0' : ''}>
              {/* Unobtrusive multi-location identifier to avoid mixups without clustering the header */}
              <div className="hidden print:block text-[9pt] font-mono font-bold text-gray-400 text-right uppercase tracking-widest mb-4">
                Facility: {sessionGroup.locationName}
              </div>

              {/* High-visibility grid layout */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 print:gap-8">
                {sortedCourts.map(cNum => {
                  const court = sessionGroup.courts[cNum];
                  if (cNum === 'Unassigned') return null;

                  return (
                    <div 
                      key={cNum} 
                      className="border-2 border-gray-400 rounded-xl p-6 print:p-8 flex flex-col justify-between bg-gray-50/30 print:bg-white print:break-inside-avoid print:shadow-none shadow-sm"
                      style={{ minHeight: '12rem' }}
                    >
                      <div>
                        {/* Court Title Banner */}
                        <div className="border-b-2 border-gray-800 pb-2 mb-4">
                          <h2 className="text-2xl print:text-3xl font-black text-gray-900 tracking-tight uppercase">
                            Court {court.courtNumber}
                          </h2>
                        </div>

                        {/* Player Roster - Explicit 18pt font constraint */}
                        <ul className="space-y-2.5 font-bold text-gray-900">
                          {court.players.map((name, pIdx) => (
                            <li key={pIdx} className="text-[18pt] leading-none tracking-wide truncate">
                              {name}
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Rules & Notes Footing Block */}
                      {(court.rotationText || court.noteText) && (
                        <div className="mt-6 pt-4 border-t-2 border-dotted border-gray-300 text-gray-700 text-xs print:text-[13pt] space-y-1.5 font-medium">
                          {court.rotationText && (
                            <p className="leading-tight">
                              <span className="font-extrabold text-gray-900">Move:</span> {court.rotationText}
                            </p>
                          )}
                          {court.noteText && (
                            <p className="bg-amber-50/60 print:bg-gray-100/70 p-2 rounded border border-amber-100 print:border-gray-200 italic font-normal leading-snug">
                              "{court.noteText}"
                            </p>
                          )}
                        </div>
                      )}
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