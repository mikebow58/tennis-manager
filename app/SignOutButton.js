'use client'

import { createBrowserClient } from '@supabase/ssr'
import { useRouter, usePathname } from 'next/navigation'

export default function SignOutButton() {
  const router = useRouter()
  const pathname = usePathname()

  // Public (player-facing) route prefixes — admin nav must never render here.
  // BUG FIX (Aug 30, 2026 session): '/subs' was missing, so the confirm/
  // decline page (/subs/respond) was rendering the admin nav bar to
  // players. Add any new player-facing route prefix here AND to
  // isPublicRoute in lib/supabase-middleware.js — two separate allowlists,
  // both must be updated together.
  // NOTE: '/portal' is not yet added — the Player Portal (Project Summary
  // §8.8) doesn't exist yet. Add it here when that page is built.
  const isPublicRoute =
    pathname.startsWith('/signup') ||
    pathname.startsWith('/cancel') ||
    pathname.startsWith('/subs') ||
    pathname.startsWith('/contact') ||
    pathname.startsWith('/login')

  if (isPublicRoute) return null

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
  )

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <nav className="border-b border-gray-200 px-4 md:px-8 py-3 flex items-center justify-between">
      <div className="flex items-center gap-4 md:gap-8">
        <span className="font-semibold text-gray-900 text-sm md:text-base">TRC</span>
        <a href="/" className="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>
        <a href="/players" className="text-sm text-gray-600 hover:text-gray-900">Players</a>
        <a href="/weeks" className="text-sm text-gray-600 hover:text-gray-900">Weeks</a>
        <a href="/admin/settings" className="text-sm text-gray-600 hover:text-gray-900">Settings</a>
      </div>
      <button
        onClick={handleSignOut}
        className="text-sm text-gray-500 hover:text-gray-900"
      >
        Sign out
      </button>
    </nav>
  )
}