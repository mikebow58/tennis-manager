'use client'

// app/components/ContactForm.js
//
// Player-to-organizer messaging (post-beta item #9). Shared between two
// entry points:
//   - app/contact/[token]/page.js — mode="token", player already identified
//     server-side via a valid, active signup_token. Only asks for the
//     message itself.
//   - app/contact/page.js — mode="anonymous", used when there's no valid
//     token to identify the player against (broken/expired link case, or
//     the invalid-token fallback inside app/contact/[token]/page.js).
//     Asks for name + email + message.
//
// Posts to POST /api/contact, which re-validates everything server-side —
// this component never sends a name/email the server would trust blindly
// in token mode; only `token` and `message` are sent in that case.

import { useState } from 'react'

export default function ContactForm({ mode, token, playerFirstName }) {
  const isAnonymous = mode === 'anonymous'

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (isAnonymous && !name.trim()) {
      setError('Please enter your name.')
      return
    }
    if (isAnonymous && !email.trim()) {
      setError('Please enter your email.')
      return
    }
    if (!message.trim()) {
      setError('Please enter a message.')
      return
    }

    setSending(true)
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isAnonymous
            ? { mode: 'anonymous', name: name.trim(), email: email.trim(), message: message.trim() }
            : { mode: 'token', token, message: message.trim() }
        ),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to send message')
      }

      setSent(true)
    } catch (err) {
      console.error('[ContactForm] submit error:', err)
      setError('Something went wrong — please try again.')
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <div className="text-center py-8">
        <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M5 13l4 4L19 7" stroke="#15803d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h2 className="text-lg font-medium text-gray-900 mb-1">Message sent</h2>
        <p className="text-sm text-gray-500">
          Thanks — the organizer has been notified and will get back to you.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {isAnonymous && (
        <>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Your email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </>
      )}
      <div>
        <label className="block text-sm text-gray-600 mb-1">What's going on?</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          placeholder="Let us know what's happening and we'll get back to you."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={sending}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        {sending ? 'Sending...' : 'Send message'}
      </button>
    </form>
  )
}