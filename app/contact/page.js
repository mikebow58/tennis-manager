// app/contact/page.js
//
// Static contact info page (replaces the old player-to-organizer contact
// FORM — post-beta item #9 — which was retired for security reasons:
// unauthenticated free-text submission with no rate limiting was both a
// spam vector and an HTML/email-injection vector via unescaped fields in
// sendPlayerContactSubmission. See dev session notes, Sept 2026, "contact
// page security review" for the full writeup.
//
// This route is intentionally static from the player's perspective: no
// form, no POST endpoint, no token handling. It replaces both the old
// app/contact/page.js (anonymous mode) and app/contact/[token]/page.js
// (token mode) — a single page now serves every entry point (signup page
// footer, cancel page footer, and any direct /contact link), regardless of
// whether a token was present. The [token] dynamic route has been deleted.
//
// Deliberately has no submission mechanism of any kind, so there is
// nothing here to spam and nothing here to inject into.
//
// Pulls organiser email and phone live from admin_settings via
// lib/admin-settings.js (getAdminEmail / getAdminPhone) rather than
// hardcoding them — so a change made on the Settings page (e.g. a stand-in
// organiser's number while the primary organiser is away) is reflected
// immediately with no redeploy. Both settings support comma-separated
// multiple values; each is rendered as its own line/link.
//
// BUG FIX (this revision): added `export const dynamic = 'force-dynamic'`.
// Without it, Next.js caches this page's server-rendered output since the
// underlying Supabase reads are fetch-based and cacheable by default. The
// page was rendering once (capturing whatever admin_settings values existed
// at that moment) and serving that same cached output on every subsequent
// request — a browser hard-refresh has no effect on this, since the cache
// lives server-side. Symptom: organiser added a phone number in Settings
// after the page had already been rendered once, and the contact page kept
// showing the old (phone-less) version indefinitely. force-dynamic makes
// this route re-run its data fetch on every request, which is the correct
// behaviour for a page displaying admin-configurable settings that can
// change at any time.

export const dynamic = 'force-dynamic'

import { getAdminEmail, getAdminPhone } from '@/lib/admin-settings'

export default async function ContactPage() {
  const [adminEmail, adminPhone] = await Promise.all([
    getAdminEmail(),
    getAdminPhone(),
  ])

  const emails = adminEmail
    ? adminEmail.split(',').map((e) => e.trim()).filter(Boolean)
    : []
  const phones = adminPhone
    ? adminPhone.split(',').map((p) => p.trim()).filter(Boolean)
    : []

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Contact us</h1>
        <p className="text-sm text-gray-500">
          Having trouble, or need to reach the organizer? Get in touch directly:
        </p>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 space-y-4">
        {emails.length > 0 && (
          <div>
            <div className="text-sm text-gray-500 mb-1">Email</div>
            {emails.map((email) => (
              <a
                key={email}
                href={`mailto:${email}`}
                className="block text-blue-600 font-medium hover:underline"
              >
                {email}
              </a>
            ))}
          </div>
        )}

        {phones.length > 0 && (
          <div>
            <div className="text-sm text-gray-500 mb-1">Text or call</div>
            {phones.map((phone) => (
              <a
                key={phone}
                href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                className="block text-blue-600 font-medium hover:underline"
              >
                {phone}
              </a>
            ))}
          </div>
        )}

        {emails.length === 0 && phones.length === 0 && (
          <p className="text-sm text-gray-500">
            Contact information is not currently available. Please try again later.
          </p>
        )}
      </div>
    </div>
  )
}