// lib/week-dates.js
//
// Mountain-Time-safe date helpers shared by the weekly-cycle crons
// (weekly-signup-send, approval-reminder, urgent-approval-reminder).
//
// WHY THIS FILE EXISTS (Nov 17, 2026 — signup send moved to Wednesday evening):
// Each of those crons used to carry its own copy of "find the upcoming Monday"
// using raw UTC arithmetic (today.getUTCDay()). That was safe while every
// cron fired in the morning, nowhere near UTC midnight. The signup send now
// fires Wednesday 6:00pm Mountain, which is Thursday 00:00 UTC — so the UTC
// weekday is already "Thursday" while Mountain time is still Wednesday. Raw UTC
// math happens to land on the same Monday for the real schedule, but it is a
// trap for manual curl testing in the evening and for any future schedule
// change. All three crons now share this one Mountain-based implementation,
// using the same Intl.DateTimeFormat('America/Denver') pattern as daily-8am.
//
// week_start_date is stored as a date-only string 'YYYY-MM-DD' (always a
// Monday).

/**
 * Formats a Date as 'YYYY-MM-DD' in America/Denver time.
 * @param {Date} date
 * @returns {string}
 */
export function toMountainDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * Returns the date string (YYYY-MM-DD) of the next Monday strictly after
 * "today" in Mountain time (never today itself, even if today is a Monday).
 *
 * From Tuesday this is +6 days, from Wednesday +5, from Thursday +4 — the
 * calculation is generic, so it also behaves correctly if a cron is triggered
 * manually on any other day.
 *
 * @param {Date} [now] - injectable for testing; defaults to the current time.
 * @returns {string} 'YYYY-MM-DD'
 */
export function getUpcomingMondayStr(now = new Date()) {
  // Today's Mountain date, anchored at noon UTC so that getUTCDay() and
  // setUTCDate() below operate on the intended calendar day with no
  // timezone rollover surprises.
  const todayMountain = toMountainDateStr(now)
  const anchor = new Date(todayMountain + 'T12:00:00Z')

  const dayOfWeek = anchor.getUTCDay() // 0=Sun, 1=Mon, ..., 6=Sat
  let daysUntilMonday = (8 - dayOfWeek) % 7
  if (daysUntilMonday === 0) daysUntilMonday = 7

  anchor.setUTCDate(anchor.getUTCDate() + daysUntilMonday)
  return anchor.toISOString().slice(0, 10)
}

/**
 * Formats a week start date (a Monday, 'YYYY-MM-DD') as a Monday–Saturday
 * range label. Example: "2026-11-23" -> "Nov 23 – Nov 28".
 *
 * @param {string} weekStartDate
 * @returns {string}
 */
export function formatWeekRangeLabel(weekStartDate) {
  const start = new Date(weekStartDate + 'T12:00:00Z')
  const end = new Date(weekStartDate + 'T12:00:00Z')
  end.setUTCDate(start.getUTCDate() + 5) // Monday + 5 = Saturday

  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' }
  return `${start.toLocaleDateString('en-US', options)} – ${end.toLocaleDateString('en-US', options)}`
}