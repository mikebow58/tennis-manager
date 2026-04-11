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
                  <SignOutButton />
        
        <main>
          {children}
        </main>
      </body>
    </html>
  )
}