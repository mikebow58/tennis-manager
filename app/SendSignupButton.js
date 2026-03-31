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
      setResult(`Sent ${data.results.sent} · skipped ${data.results.skipped} · failed ${data.results.failed}`)
    } else {
      setResult('Something went wrong.')
    }
  }

  if (sent) {
    return (
    <div className="flex justify-between items-center max-w-xs">
      <span className="text-xs font-medium text-emerald-400">Signup requests sent</span>
      <span className="text-xs text-slate-300">{sentLabel}</span>
    </div>
  )
  }

  return (
    <div className="flex justify-between items-center">
      <button
        onClick={handleSend}
        disabled={sending}
        className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {sending ? 'Sending...' : 'Send signup requests'}
      </button>
      {result && <p className="text-xs text-slate-400">{result}</p>}
    </div>
  )
}