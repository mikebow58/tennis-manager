export function formatTime(timeString) {
  if (!timeString) return ''
  const [hourStr, minuteStr] = timeString.slice(0, 5).split(':')
  const hour = parseInt(hourStr)
  const minute = minuteStr
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour % 12 || 12
  return `${displayHour}:${minute} ${ampm}`
}

export function getTimeOptions() {
  const options = []
  for (let hour = 6; hour <= 12; hour++) {
    // Only on the hour and half hour — consistent with session scheduling practice
    for (let minute of ['00', '30']) {
      const value = `${String(hour).padStart(2, '0')}:${minute}:00`
      const displayHour = hour > 12 ? hour - 12 : hour
      const ampm = hour >= 12 ? 'PM' : 'AM'
      const label = `${displayHour}:${minute} ${ampm}`
      options.push({ value, label })
    }
  }
  return options
}

// BUG FIX (dev session Aug 25, 2026): this was still the pre-V2 10-point
// scale (1-10), left over from before the V2 migration repurposed
// skill_admin to an 8-point scale (Project Summary Section 3 / Automation
// Logic Section 10 / Automation Logic Section 17.1's migration note:
// "repurposed as integer 1-8. Rename/migrate from prior 1-10 numeric
// mapping"). This dictionary was never updated to match, meaning every
// display using getSkillLabel AND both admin-facing skill dropdowns
// (players/new and players/[id], via getSkillOptions) were showing wrong
// labels and offering two invalid choices (9, 10) that don't exist on the
// real scale. app/admin/court-assignment/[sessionId]/CourtAssignmentClient.js
// has its own separate, already-correct copy of this same mapping — worth
// consolidating to import from here instead, at some point, so there's
// only one source of truth.
export const SKILL_LABELS = {
  1: '3.0-',
  2: '3.0',
  3: 'Strong 3.0',
  4: '3.5',
  5: 'Strong 3.5',
  6: '4.0',
  7: 'Strong 4.0',
  8: '4.5+',
}

export function getSkillLabel(value) {
  if (value === null || value === undefined || value === '') return '—'
  return SKILL_LABELS[Number(value)] || value
}

export function getSkillOptions() {
  return Object.entries(SKILL_LABELS).map(([value, label]) => ({
    value: String(value),
    label
  }))
}

/**
 * Checks if a tennis session date has already passed.
 * @param {string} date - The date of the session
 * @returns {boolean} - True if the session is over
 */
export function isSessionCompleted(sessionDate) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const session = new Date(sessionDate + 'T00:00:00')
  return session < today
}

/**
 * Formats a 24-hour time string (e.g. "20:00") into a display-friendly
 * string (e.g. "8:00pm") for use in organiser alert emails.
 *
 * @param {string} time24 - Time in "HH:MM" 24-hour format
 * @returns {string}
 */
export function formatDeadlineTime(time24) {
  const [hourStr, minuteStr] = time24.split(':')
  const hour = parseInt(hourStr, 10)
  const minute = parseInt(minuteStr, 10)
  const period = hour >= 12 ? 'pm' : 'am'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  const displayMinute = minute === 0 ? '' : `:${minuteStr}`
  return `${displayHour}${displayMinute}${period}`
}