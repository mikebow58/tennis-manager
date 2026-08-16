'use client'

import { useState } from 'react'
import { formatTime } from '@/lib/utils'

// THIS REVISION (post-beta item #7 — "Confirm button UX improvement"):
// the submit button below is relabelled from "Confirm signup" to
// "Submit my days" and made visually more prominent (larger padding,
// bolder text, subtle shadow) per the Project Summary Section 21 spec.
// The button was already disabled when no days are selected as of an
// earlier beta bug-fix pass — that behaviour is unchanged here, still
// driven by `disabled={saving || selected.length === 0}` below.
//
// THIS REVISION (post-beta item #6 — "I'm out this week"): whole-week,
// non-rescindable opt-out added below the submit button. Always visible,
// per organiser decision, even when day(s) are already selected — in that
// case the click first shows an inline confirmation (not a browser
// confirm()) since selecting it wipes the current selection. See
// app/api/signup/[token]/opt-out/route.js for the server-side logic.

export default function SignupForm({ player, sessions, signedUpSessionIds }) {
  const safeInitial = Array.isArray(signedUpSessionIds) ? signedUpSessionIds : []
  const [selected, setSelected] = useState(safeInitial)
  const [saving, setSaving] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [savedSessionIds, setSavedSessionIds] = useState(safeInitial)
  const [error, setError] = useState(null)

  // Maps session_id -> 'confirmed' | 'waitlisted', populated from the POST
  // response's `results` array (added this revision — see /api/availability
  // route.js header for the server-side change this depends on).
  //
  // KNOWN GAP: this map is only populated after a successful POST in THIS
  // browser session. A player who was waitlisted on a prior visit and
  // returns later (without changing their selection, so no new POST fires)
  // will not have their waitlisted status reflected here — sessions present
  // in the initial signedUpSessionIds prop but absent from this map fall
  // back to 'confirmed' styling below. Fixing this properly requires the
  // server component that supplies signedUpSessionIds to also supply each
  // session's current status, which is outside this file. Flagging rather
  // than silently guessing.
  const [sessionStatuses, setSessionStatuses] = useState({})

  // Post-beta item #6 — "I'm out this week."
  const [showOptOutConfirm, setShowOptOutConfirm] = useState(false)
  const [optingOut, setOptingOut] = useState(false)
  const [optOutError, setOptOutError] = useState(null)
  const [optedOutResult, setOptedOutResult] = useState(null) // { skippedClosedSessions: [] }

  function toggleSession(sessionId) {
    setSelected(prev =>
      prev.includes(sessionId)
        ? prev.filter(id => id !== sessionId)
        : [...prev, sessionId]
    )
  }

  async function handleConfirm() {
    setSaving(true)
    setError(null)

    try {
      const toAdd = selected.filter(id => !savedSessionIds.includes(id))
      const toRemove = savedSessionIds.filter(id => !selected.includes(id))

      const baseUrl = window.location.origin

      if (toRemove.length > 0) {
        const res = await fetch(`${baseUrl}/api/availability`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: player.id,
            sessionIds: toRemove,
            signup_token: player.signup_token
          })
        })
        if (!res.ok) {
          const text = await res.text()
          console.error('DELETE failed:', res.status, text)
          throw new Error('Failed to remove sessions')
        }
        // Clear statuses for removed sessions — they're no longer signed up.
        setSessionStatuses(prev => {
          const next = { ...prev }
          toRemove.forEach(id => delete next[id])
          return next
        })
      }

      if (toAdd.length > 0) {
        const res = await fetch(`${baseUrl}/api/availability`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toAdd.map(sessionId => ({
            session_id: sessionId,
            player_id: player.id,
            status: 'confirmed', // ignored server-side; server determines actual status
            signup_token: player.signup_token
          })))
        })
        if (!res.ok) {
          const text = await res.text()
          console.error('POST failed:', res.status, text)
          throw new Error('Failed to save sessions')
        }

        const data = await res.json()
        // data.results: [{ session_id, status }, ...] — capture the
        // server's actual determination (confirmed vs waitlisted) per session.
        if (Array.isArray(data.results)) {
          setSessionStatuses(prev => {
            const next = { ...prev }
            data.results.forEach(r => {
              next[r.session_id] = r.status
            })
            return next
          })
        } else {
          console.warn('POST response missing results array — cannot determine waitlist status')
        }
      }

      setSavedSessionIds(selected)
      setConfirmed(true)
    } catch (err) {
      console.error('Signup error:', err)
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  // Post-beta item #6 — "I'm out this week." Called after the inline
  // confirmation panel is accepted. Non-rescindable: there is no undo
  // path from this state by design, so no client-side retry-with-change
  // logic is needed here — only error retry.
  async function handleOptOutConfirmed() {
    setOptingOut(true)
    setOptOutError(null)

    try {
      const baseUrl = window.location.origin
      const res = await fetch(`${baseUrl}/api/signup/${player.signup_token}/opt-out`, {
        method: 'POST',
      })

      if (!res.ok) {
        const text = await res.text()
        console.error('Opt-out failed:', res.status, text)
        throw new Error('Failed to opt out')
      }

      const data = await res.json()
      setOptedOutResult({ skippedClosedSessions: data.skippedClosedSessions ?? [] })
      setShowOptOutConfirm(false)
    } catch (err) {
      console.error('Opt-out error:', err)
      setOptOutError('Something went wrong. Please try again.')
    } finally {
      setOptingOut(false)
    }
  }

  // ------------------------------------------------------------------
  // Opted-out final screen. Checked before the `confirmed` screen below
  // since it can only be reached by explicitly choosing to opt out, and
  // once here there's no path back to the day-picker in this session.
  // ------------------------------------------------------------------
  if (optedOutResult) {
    return (
      <div className="text-center py-8">
        <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h2 className="text-lg font-medium text-gray-900 mb-1">
          You're marked as out this week
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          We'll see you next week, {player.first_name}!
        </p>
        {optedOutResult.skippedClosedSessions.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-left text-xs text-amber-800 mx-auto max-w-sm">
            You still have a confirmed spot on{' '}
            {optedOutResult.skippedClosedSessions.map((d, i) => (
              <span key={d}>
                {i > 0 ? ', ' : ''}
                {new Date(d).toLocaleDateString('en-US', {
                  weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'
                })}
              </span>
            ))}
            {' '}— that session already sent its reminder, so please use the
            cancel link in that reminder email to remove yourself from it.
          </div>
        )}
      </div>
    )
  }

  if (confirmed) {
    const confirmedSessions = sessions.filter(s => selected.includes(s.id))

    return (
      <div className="text-center py-8">
        <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M5 13l4 4L19 7" stroke="#15803d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h2 className="text-lg font-medium text-gray-900 mb-1">
          You're all set, {player.first_name}!
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          Thank you for signing up to play this week.
        </p>
        {selected.length === 0 ? (
          <p className="text-sm text-gray-400 mb-6">You are not signed up for any days this week.</p>
        ) : (
          <div className="space-y-2 mb-6 text-left">
            {confirmedSessions.map(session => {
              // Falls back to 'confirmed' if not present in sessionStatuses —
              // see KNOWN GAP note above the state declaration.
              const status = sessionStatuses[session.id] ?? 'confirmed'
              const isWaitlisted = status === 'waitlisted'

              return (
                <div
                  key={session.id}
                  className={`rounded-lg px-4 py-2.5 border ${
                    isWaitlisted
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-green-50 border-green-200'
                  }`}
                >
                  <div className={`text-sm font-medium ${isWaitlisted ? 'text-amber-800' : 'text-green-800'}`}>
                    {new Date(session.session_date).toLocaleDateString('en-US', {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      timeZone: 'UTC'
                    })}
                  </div>
                  <div className={`text-xs mt-0.5 ${isWaitlisted ? 'text-amber-600' : 'text-green-600'}`}>
                    {session.start_time ? formatTime(session.start_time) : ''} · {session.location}
                  </div>
                  {isWaitlisted && (
                    <div className="text-xs mt-1.5 text-amber-700 font-medium">
                      This session is full — you've been added to the waitlist.
                      We'll let you know right away if a spot opens up.
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <button
          onClick={() => setConfirmed(false)}
          className="text-sm text-blue-600 hover:underline"
        >
          Need to change your days?
        </button>
      </div>
    )
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        Select the days you'd like to play this week.
      </p>
      <div className="space-y-2 mb-8">
        {sessions.length === 0 ? (
          <p className="text-gray-500 text-sm">No sessions are open for signup right now.</p>
        ) : (
          sessions.map((session) => {
            const isSelected = selected.includes(session.id)
            const dateLabel = new Date(session.session_date).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC'
            })

            return (
              <div
                key={session.id}
                onClick={() => toggleSession(session.id)}
                className={`flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-green-50 border-green-300'
                    : 'bg-white border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div>
                  <div className={`font-medium text-sm ${isSelected ? 'text-green-800' : 'text-gray-900'}`}>
                    {dateLabel}
                  </div>
                  <div className={`text-xs mt-0.5 ${isSelected ? 'text-green-600' : 'text-gray-400'}`}>
                    {session.start_time ? formatTime(session.start_time) : ''} · {session.location}
                  </div>
                </div>
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  isSelected ? 'bg-green-500 border-green-500' : 'border-gray-300'
                }`}>
                  {isSelected && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {error && (
        <p className="text-red-600 text-sm mb-4 text-center">{error}</p>
      )}

      {/*
        Post-beta item #7: relabelled "Confirm signup" -> "Submit my days",
        and made more prominent — larger vertical padding (py-4 vs py-3),
        larger text (text-base vs default), bolder weight (font-semibold vs
        font-medium), and a subtle shadow that lifts slightly further on
        hover. Disabled state (no days selected, or a save in flight) is
        unchanged — still the sole gate on this button per the existing
        beta bug-fix behaviour.
      */}
      <button
        type="button"
        onClick={handleConfirm}
        disabled={saving || selected.length === 0}
        className="w-full bg-green-600 text-white py-4 rounded-lg text-base font-semibold shadow-md hover:bg-green-700 hover:shadow-lg transition-shadow disabled:opacity-50 disabled:shadow-none"
      >
        {saving ? 'Submitting...' : 'Submit my days'}
      </button>

      {/*
        Post-beta item #6 — "I'm out this week." Always available, per
        organiser decision, even when day(s) are already selected — in
        that case selecting it wipes the selection, so an inline
        confirmation is shown first rather than acting immediately.
      */}
      <div className="mt-4 text-center">
        {!showOptOutConfirm ? (
          <button
            type="button"
            onClick={() => setShowOptOutConfirm(true)}
            className="text-sm text-gray-400 hover:text-gray-600 hover:underline"
          >
            I'm out this week
          </button>
        ) : (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-left mt-2">
            <p className="text-sm text-gray-700 mb-3">
              {selected.length > 0
                ? `This will remove your selected day${selected.length > 1 ? 's' : ''} and mark you as out for the whole week. This can't be undone.`
                : `This will mark you as out for the whole week. This can't be undone.`}
            </p>
            {optOutError && (
              <p className="text-red-600 text-xs mb-3">{optOutError}</p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowOptOutConfirm(false)}
                disabled={optingOut}
                className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleOptOutConfirmed}
                disabled={optingOut}
                className="flex-1 bg-gray-700 text-white py-2 rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
              >
                {optingOut ? 'Submitting...' : "Yes, I'm out"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}