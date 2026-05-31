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

export const SKILL_LABELS = {
  1: '3.0−',
  2: '3.0 Avg',
  3: '3.0 High',
  4: '3.5 Low',
  5: '3.5 Avg',
  6: '3.5 High',
  7: '4.0 Low',
  8: '4.0 Avg',
  9: '4.0 High',
  10: '4.5+',
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