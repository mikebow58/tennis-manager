/**
 * SessionListClient
 *
 * Client component that owns the sessions list in local state.
 * Receives the server-fetched sessions and locations arrays as props,
 * then renders one ApproveWeekClient row per session.
 *
 * Holding sessions in useState here (rather than in the server component)
 * allows a deleted session to be removed from the list immediately without
 * a full page reload — the server component has no React state to update.
 *
 * @param {object[]} sessions   - Session records fetched by the server component
 * @param {object[]} locations  - Active location records { id, name }
 * @param {boolean}  isEditable - Whether inline editing is allowed (pending_approval weeks only)
 * @param {string}   weekId     - Parent week UUID
 */

'use client'

import { useState } from 'react'
import ApproveWeekClient from './ApproveWeekClient'

export default function SessionListClient({ sessions: initialSessions, locations, isEditable, weekId }) {
  // Sessions held in state so individual rows can be removed on delete
  const [sessions, setSessions] = useState(initialSessions)

  /**
   * Removes a session from the local list after a successful delete.
   * Called by ApproveWeekClient once the DELETE API call confirms success.
   *
   * @param {string} sessionId - UUID of the deleted session
   */
  function handleDelete(sessionId) {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
  }

  // Empty state — shown if all sessions have been deleted or none exist
  if (sessions.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-8 text-center text-sm text-gray-400">
        No sessions found for this week.
      </div>
    )
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Sessions
      </h2>
      <div className="space-y-2">
        {sessions.map((session) => {
          // Build the human-readable date label for each session row
          const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          })

          return (
            <ApproveWeekClient
              key={session.id}
              session={session}
              dateLabel={dateLabel}
              isEditable={isEditable}
              weekId={weekId}
              locations={locations}
              onDelete={handleDelete}
            />
          )
        })}
      </div>
    </div>
  )
}