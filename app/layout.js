import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata = {
  title: "Tennis Manager",
  description: "Group tennis management",
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <nav className="border-b border-gray-200 px-8 py-4 flex items-center gap-8">
          <span className="font-semibold text-gray-900">Tennis Manager</span>
          <a href="/" className="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>
          <a href="/players" className="text-sm text-gray-600 hover:text-gray-900">Players</a>
          <a href="/weeks" className="text-sm text-gray-600 hover:text-gray-900">Weeks</a>
        </nav>
        <main>
          {children}
        </main>
      </body>
    </html>
  )
}