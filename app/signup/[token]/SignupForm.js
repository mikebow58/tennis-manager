'use client'

import { useState } from 'react'
import { formatTime } from '@/lib/utils'

// THIS REVISION (Oct 30, 2026 — day-level signup):
// SYMPTOM: on a split-location day the form showed two rows for the same
// day (same start time, no way to tell them apart), and the venue column it
// tried to show came from the freeform sessions.location field, which is
// empty for sessions created from default_sessions. A player's click on one
// row or the other also decided whether they were waitlisted.
// ROOT CAUSE: the form rendered one row per SESSION record. Players sign up
// for the DAY; venue assignment is decided later at court assignment.
// FIX: the form now receives `days` (built in page.js: one entry per
// session_date) and renders one row per day with no venue shown. Selection,
// saved state, and statuses are keyed by day key (the session_date string).
// On submit, the form POSTs one session_id per added day (the day's
// primarySessionId); /api/availability resolves the real session server-side
// and returns which one the player landed on plus confirmed/waitlisted.
// Removal sends EVERY session id for a removed day, so it matches whichever
// sibling row the player holds.
//
// ALSO IN THIS REVISION:
//   - Closes the "KNOWN GAP" from the previous revision: dayStatuses is now
//     seeded from the server-supplied signedUpDays, so a player waitlisted
//     on an earlier visit sees waitlisted styling when they return.
//   - START-TIME HINT (easy to turn off): when SHOW_START_TIME_HINT is true,
//     a single line under the intro shows the week's usual start time
//     (e.g. "Sessions start at 9:00am"), and a day whose start time(s) differ
//     from the usual one gets a small "Starts ..." note on its row. Set the
//     constant below to false to show days only, with no times at all.
//   - Waitlist wording now names the day ("Wednesday is full") instead of
//     "This session is full".
//
// PROPS CHANGED: `sessions` and `signedUpSessionIds` are replaced by `days`
// and `signedUpDays`. app/signup/[token]/page.js (also revised) is the only
// caller; deploy both files together.
//
// ---------------------------------------------------------------------
// PRIOR HISTORY (retained)
// ---------------------------------------------------------------------
// (post-beta item #7 — "Confirm button UX improvement"): the submit button is
// labelled "Submit my days" and made visually prominent (larger padding,
// bolder text, subtle shadow). It is disabled when no days are selected, via
// `disabled={saving || selected.length === 0}` below.
//
// (post-beta item #6 — "I'm out this week"): whole-week, non-rescindable
// opt-out below the submit button. Always visible, per organiser decision,
// even when day(s) are already selected — in that case the click first shows
// an inline confirmation (not a browser confirm()) since selecting it wipes
// the current selection. See app/api/signup/[token]/opt-out/route.js.

// Set to false to hide ALL start-time text on the signup page (days only).
const SHOW_START_TIME_HINT = true

/**
 * Long date label used on rows and on the confirmation screen.
 * UTC is used because session_date is a bare date string, so a local-time
 * parse could shift it back a day in negative-offset time zones.
 * @param {string} sessionDate - e.g. "2026-11-04"
 * @returns {string} e.g. "Wednesday, November 4"
 */
function longDateLabel(sessionDate) {
  return new Date(sessionDate).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Weekday name only, used in the waitlist message.
 * @param {string} sessionDate - e.g. "2026-11-04"
 * @returns {string} e.g. "Wednesday"
 */
function weekdayName(sessionDate) {
  return new Date(sessionDate).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  })
}

export default function SignupForm({ player, days, signedUpDays }) {
  const safeDays = Array.isArray(days) ? days : []
  const initialStatuses = signedUpDays && typeof signedUpDays === 'object' ? signedUpDays : {}
  const initialKeys = Object.keys(initialStatuses)

  // Day keys (session_date strings) currently ticked in the picker.
  const [selected, setSelected] = useState(initialKeys)
  const [saving, setSaving] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  // Day keys last saved to the server — used to work out adds and removals.
  const [savedDayKeys, setSavedDayKeys] = useState(initialKeys)
  const [error, setError] = useState(null)

  // Maps day key -> 'confirmed' | 'waitlisted'. Seeded from the server so
  // returning visitors see their real status; updated from POST responses.
  const [dayStatuses, setDayStatuses] = useState(initialStatuses)

  // Post-beta item #6 — "I'm out this week."
  const [showOptOutConfirm, setShowOptOutConfirm] = useState(false)
  const [optingOut, setOptingOut] = useState(false)
  const [optOutError, setOptOutError] = useState(null)
  const [optedOutResult, setOptedOutResult] = useState(null) // { skippedClosedSessions: [] }

  // Lookup tables built from the days prop (cheap; days is small).
  const dayByKey = {}
  const sessionIdToDayKey = {}
  safeDays.forEach((day) => {
    dayByKey[day.key] = day
    day.sessionIds.forEach((id) => {
      sessionIdToDayKey[id] = day.key
    })
  })

  // ------------------------------------------------------------------
  // Start-time hint: find the most common start-time signature across days.
  // A signature is a day's distinct start times joined with "|".
  // ------------------------------------------------------------------
  const signatureCounts = {}
  safeDays.forEach((day) => {
    const signature = day.startTimes.join('|')
    if (signature) signatureCounts[signature] = (signatureCounts[signature] || 0) + 1
  })
  let modalSignature = ''
  let modalCount = 0
  Object.entries(signatureCounts).forEach(([signature, count]) => {
    if (count > modalCount) {
      modalSignature = signature
      modalCount = count
    }
  })
  // Only a single, unambiguous usual time gets the header line.
  const headerTime =
    SHOW_START_TIME_HINT && modalSignature && !modalSignature.includes('|')
      ? formatTime(modalSignature)
      : null

  /**
   * Small per-day note when a day's start time differs from the usual one
   * (or when there is no single usual time). Empty string means no note.
   * @param {{startTimes:string[]}} day
   * @returns {string}
   */
  function timeNote(day) {
    if (!SHOW_START_TIME_HINT || day.startTimes.length === 0) return ''
    const signature = day.startTimes.join('|')
    if (headerTime && signature === modalSignature) return ''
    return `Starts ${day.startTimes.map((t) => formatTime(t)).join(' / ')}`
  }

  function toggleDay(dayKey) {
    setSelected(prev =>
      prev.includes(dayKey)
        ? prev.filter(key => key !== dayKey)
        : [...prev, dayKey]
    )
  }

  async function handleConfirm() {
    setSaving(true)
    setError(null)
    console.log(`[SignupForm] submit: selected=${selected.length} saved=${savedDayKeys.length}`)

    try {
      const daysToAdd = selected.filter(key => !savedDayKeys.includes(key))
      const daysToRemove = savedDayKeys.filter(key => !selected.includes(key))

      const baseUrl = window.location.origin

      if (daysToRemove.length > 0) {
        // Send EVERY session id for each removed day so the server matches
        // whichever sibling session the player's row is actually on.
        const sessionIdsToRemove = daysToRemove.flatMap(key => dayByKey[key]?.sessionIds ?? [])

        const res = await fetch(`${baseUrl}/api/availability`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: player.id,
            sessionIds: sessionIdsToRemove,
            signup_token: player.signup_token
          })
        })
        if (!res.ok) {
          const text = await res.text()
          console.error('DELETE failed:', res.status, text)
          throw new Error('Failed to remove days')
        }
        // Clear statuses for removed days — they're no longer signed up.
        setDayStatuses(prev => {
          const next = { ...prev }
          daysToRemove.forEach(key => delete next[key])
          return next
        })
      }

      if (daysToAdd.length > 0) {
        const res = await fetch(`${baseUrl}/api/availability`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // One entry per day: the day's primary session id. The server
          // resolves the real session (and venue) — see lib/day-capacity.js.
          body: JSON.stringify(daysToAdd.map(key => ({
            session_id: dayByKey[key].primarySessionId,
            player_id: player.id,
            status: 'confirmed', // ignored server-side; server determines actual status
            signup_token: player.signup_token
          })))
        })
        if (!res.ok) {
          const text = await res.text()
          console.error('POST failed:', res.status, text)
          throw new Error('Failed to save days')
        }

        const data = await res.json()
        // data.results: [{ requested_session_id, session_id, status }, ...].
        // Map each result back to its day and record the server's
        // confirmed/waitlisted determination.
        if (Array.isArray(data.results)) {
          setDayStatuses(prev => {
            const next = { ...prev }
            data.results.forEach(r => {
              const dayKey = sessionIdToDayKey[r.requested_session_id ?? r.session_id]
              if (dayKey) next[dayKey] = r.status
            })
            return next
          })
        } else {
          console.warn('POST response missing results array — cannot determine waitlist status')
        }
      }

      setSavedDayKeys(selected)
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
    // Days in the order they appear on the page, filtered to the selection.
    const confirmedDays = safeDays.filter(day => selected.includes(day.key))

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
            {confirmedDays.map(day => {
              // Falls back to 'confirmed' if the day has no recorded status.
              const status = dayStatuses[day.key] ?? 'confirmed'
              const isWaitlisted = status === 'waitlisted'
              const note = timeNote(day)

              return (
                <div
                  key={day.key}
                  className={`rounded-lg px-4 py-2.5 border ${
                    isWaitlisted
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-green-50 border-green-200'
                  }`}
                >
                  <div className={`text-sm font-medium ${isWaitlisted ? 'text-amber-800' : 'text-green-800'}`}>
                    {longDateLabel(day.session_date)}
                  </div>
                  {note && (
                    <div className={`text-xs mt-0.5 ${isWaitlisted ? 'text-amber-600' : 'text-green-600'}`}>
                      {note}
                    </div>
                  )}
                  {isWaitlisted && (
                    <div className="text-xs mt-1.5 text-amber-700 font-medium">
                      {weekdayName(day.session_date)} is full — you've been added to the waitlist.
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
      <p className="text-sm text-gray-500 mb-1">
        Select the days you'd like to play this week.
      </p>
      {headerTime && (
        <p className="text-xs text-gray-400 mb-6">
          Sessions start at {headerTime} unless noted.
        </p>
      )}
      {!headerTime && <div className="mb-5" />}
      <div className="space-y-2 mb-8">
        {safeDays.length === 0 ? (
          <p className="text-gray-500 text-sm">No sessions are open for signup right now.</p>
        ) : (
          safeDays.map((day) => {
            const isSelected = selected.includes(day.key)
            const note = timeNote(day)

            return (
              <div
                key={day.key}
                onClick={() => toggleDay(day.key)}
                className={`flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-green-50 border-green-300'
                    : 'bg-white border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div>
                  <div className={`font-medium text-sm ${isSelected ? 'text-green-800' : 'text-gray-900'}`}>
                    {longDateLabel(day.session_date)}
                  </div>
                  {note && (
                    <div className={`text-xs mt-0.5 ${isSelected ? 'text-green-600' : 'text-gray-400'}`}>
                      {note}
                    </div>
                  )}
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