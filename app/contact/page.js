// app/contact/page.js
//
// Static contact info page (replaces the old player-to-organizer contact
// FORM — post-beta item #9 — which was retired for security reasons:
// unauthenticated free-text submission with no rate limiting was both a
// spam vector and an HTML/email-injection vector via unescaped fields in
// sendPlayerContactSubmission. See dev session notes, Sept 2026, "contact
// page security review" for the full writeup.
//
// This route is intentionally static: no form, no POST endpoint, no DB
// lookup, no token handling. It replaces both the old app/contact/page.js
// (anonymous mode) and app/contact/[token]/page.js (token mode) — a single
// page now serves every entry point (signup page footer, cancel page
// footer, and any direct /contact link), regardless of whether a token was
// present. The [token] dynamic route has been deleted; any old
// /contact/[token] links still floating in old emails will 404 harmlessly
// rather than resolving — acceptable since this is a low-traffic fallback
// link, not a primary flow.
//
// Deliberately has no submission mechanism of any kind, so there is
// nothing here to spam and nothing here to inject into.

export default function ContactPage() {
  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Contact us</h1>
        <p className="text-sm text-gray-500">
          Having trouble, or need to reach the organizer? Get in touch directly:
        </p>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 space-y-4">
        <div>
          <div className="text-sm text-gray-500 mb-1">Email</div>
          <a
            href="mailto:REPLACE_WITH_ORGANIZER_EMAIL"
            className="text-blue-600 font-medium hover:underline"
          >
            REPLACE_WITH_ORGANIZER_EMAIL
          </a>
        </div>
        <div>
          <div className="text-sm text-gray-500 mb-1">Text or call</div>
          <a
            href="tel:REPLACE_WITH_ORGANIZER_PHONE"
            className="text-blue-600 font-medium hover:underline"
          >
            REPLACE_WITH_ORGANIZER_PHONE
          </a>
        </div>
      </div>
    </div>
  )
}