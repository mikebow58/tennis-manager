'use client'

import { createBrowserClient } from '@supabase/ssr'
import { useRouter } from 'next/navigation'
import { usePathname } from 'next/navigation'

export default function SignOutButton() {
  const router = useRouter()
  const pathname = usePathname()

  const isPublicRoute =
    pathname.startsWith('/signup') ||
    pathname.startsWith('/cancel') ||
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
    <button
      onClick={handleSignOut}
      className="text-sm text-gray-500 hover:text-gray-900"
    >
      Sign out
    </button>
  )
}