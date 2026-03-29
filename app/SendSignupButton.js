'use client'

import { useState } from 'react'

export default function SendSignupButton({ weekId, signupSentAt }) {
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [sent, setSent] = useState(!!signupSentAt)

  const sentLabel = signupSentAt
    ? new Date(signupSentAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : null

  async function handleSend() {
    const confirmed = window.confirm(
      'This will email all active players their signup link for this week. Continue?'
    )
    if (!confirmed) return

    setSending(true)
    setResult(null)

    const response = await fetch('/api/send-signup-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekId })
    })

    const data = await response.json()
    setSending(false)

    if (data.success) {
      setSent(true)
      setResult(`Sent ${data.results.sent} emails · ${data.results.skipped} skipped · ${data.results.failed} failed`)
    } else {
      setResult('Something went wrong. Check the console.')
    }
  }

  if (sent) {
    return (
      <div className="text-right">
        <div className="text-xs text-green-600 font-medium">Signup requests sent</div>
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
        className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
      >
        {sending ? 'Sending...' : 'Send signup requests'}
      </button>
      {result && (
        <p className="text-xs text-gray-500 mt-2">{result}</p>
      )}
    </div>
  )
}