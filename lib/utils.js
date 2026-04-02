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