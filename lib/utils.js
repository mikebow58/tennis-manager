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
    for (let minute of ['00', '15', '30', '45']) {
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
    label: `${value} · ${label}`
  }))
}

export function isSessionCompleted(sessionDate) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const session = new Date(sessionDate + 'T00:00:00')
  return session < today
}