export function formatTime(timeString) {
  if (!timeString) return ''
  const [hourStr, minuteStr] = timeString.slice(0, 5).split(':')
  const hour = parseInt(hourStr)
  const minute = minuteStr
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour % 12 || 12
  return `${displayHour}:${minute} ${ampm}`
}