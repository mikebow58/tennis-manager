import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import SignOutButton from "./SignOutButton"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata = {
  title: "Treviso Racquet Club",
  description: "Group tennis management",
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="overflow-x-hidden">
  <body className={`${geistSans.variable} ${geistMono.variable} antialiased overflow-x-hidden w-full`}>
        <nav className="border-b border-gray-200 px-4 md:px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4 md:gap-8">
            <span className="font-semibold text-gray-900 text-sm md:text-base">TRC</span>
            <a href="/" className="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>
            <a href="/players" className="text-sm text-gray-600 hover:text-gray-900">Players</a>
            <a href="/weeks" className="text-sm text-gray-600 hover:text-gray-900">Weeks</a>
          </div>
          <SignOutButton />
        </nav>
        <main>
          {children}
        </main>
      </body>
    </html>
  )
}