'use client'

import { useState } from 'react'

export default function SendReminderButton({ sessionId, reminderSentAt, playerCount }) {
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [sent, setSent] = useState(!!reminderSentAt)

  const sentLabel = reminderSentAt
    ? new Date(reminderSentAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : null

  async function handleSend() {
    if (playerCount === 0) {
      alert('No confirmed players to remind.')
      return
    }

    const confirmed = window.confirm(
      `This will send a reminder email to ${playerCount} confirmed player${playerCount !== 1 ? 's' : ''}. Continue?`
    )
    if (!confirmed) return

    setSending(true)
    setResult(null)

    const response = await fetch('/api/send-reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    })

    const data = await response.json()
    setSending(false)

    if (data.success) {
      setSent(true)
      setResult(`Sent ${data.results.sent} · skipped ${data.results.skipped} · failed ${data.results.failed}`)
    } else {
      setResult('Something went wrong.')
    }
  }

  if (sent) {
    return (
      <div className="text-right">
        <div className="text-xs text-green-600 font-medium">Reminders sent</div>
        {sentLabel && (
          <div className="text-xs text-gray-400">{sentLabel}</div>
        )}
        {result && (
          <div className="text-xs text-gray-400 mt-1">{result}</div>
        )}
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={handleSend}
        disabled={sending}
        className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
      >
        {sending ? 'Sending...' : 'Send reminders'}
      </button>
      {result && (
        <p className="text-xs text-gray-500 mt-2">{result}</p>
      )}
    </div>
  )
}