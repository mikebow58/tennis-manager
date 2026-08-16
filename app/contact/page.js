import ContactForm from '@/app/components/ContactForm'

// app/contact/page.js
//
// Player-to-organizer messaging, anonymous mode (post-beta item #9).
// Linked from the "invalid or expired link" fallback screens on the
// signup and cancel pages — at that point the token is already known to
// be bad, so there's nothing to look up. Also used as a direct link with
// no token at all.

export default function ContactPage() {
  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Contact us</h1>
        <p className="text-sm text-gray-500">
          Send a message and we'll get back to you.
        </p>
      </div>
      <ContactForm mode="anonymous" />
    </div>
  )
}