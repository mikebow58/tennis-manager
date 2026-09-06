import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'

export async function updateSession(request) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // BUG FIX (Sept 2026 session — contact page security review): '/contact'
  // was missing from this allowlist. The contact page has no auth/token of
  // its own by design (it's a fallback for players whose signup/cancel
  // link is broken), so it must be reachable without a logged-in admin
  // session. '/api/contact' removed below — the contact FORM and its POST
  // endpoint were retired for security reasons (unauthenticated free-text
  // submission was both a spam vector and an HTML-injection vector via
  // unescaped fields in the outbound email). The route no longer exists.
  // See app/contact/page.js header comment for the full writeup.
  //
  // NOTE: any new player-facing route requires updates in BOTH this
  // allowlist AND isPublicRoute in components/SignOutButton.js — missing
  // either is a recurring bug pattern in this codebase.
  const isPublicRoute =
  pathname.startsWith('/signup') ||
  pathname.startsWith('/cancel') ||
  pathname.startsWith('/login') ||
  pathname.startsWith('/contact') ||
  pathname.startsWith('/api/availability') ||
  pathname.startsWith('/api/signup') ||
  pathname.startsWith('/api/cron/') ||
  pathname.startsWith('/subs/respond') ||
  pathname.startsWith('/api/cancel') ||
  pathname.startsWith('/api/subs/respond')

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}