import { supabaseAdmin as supabase } from '@/lib/supabase-admin'
import ContactForm from '@/app/components/ContactForm'

// app/contact/[token]/page.js
//
// Player-to-organizer messaging, token-identified mode (post-beta item #9).
// Linked from the "Having trouble with this page? Let us know" footer on
// the signup and cancel pages when the player's token is known and valid.
//
// If the token doesn't match an active player (stale link, or the player
// was deactivated since the link was sent), this does NOT dead-end — it
// falls back to rendering the anonymous form right here, so a bad token
// still gets the player to a working contact form instead of a wall.
// See app/api/contact/route.js for how the two submission modes are
// handled server-side.

export default async function ContactTokenPage({ params }) {
  const { token } = await params

  const { data: player } = await supabase
    .from('players')
    .select('id, first_name')
    .eq('signup_token', token)
    .eq('active', true)
    .single()

  if (!player) {
    return (
      <div className="max-w-md mx-auto p-6">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Contact us</h1>
          <p className="text-sm text-gray-500">
            We couldn't match this link to a player, but you can still reach us below.
          </p>
        </div>
        <ContactForm mode="anonymous" />
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Hi {player.first_name}, what's up?
        </h1>
        <p className="text-sm text-gray-500">
          Send a message and we'll get back to you.
        </p>
      </div>
      <ContactForm mode="token" token={token} playerFirstName={player.first_name} />
    </div>
  )
}