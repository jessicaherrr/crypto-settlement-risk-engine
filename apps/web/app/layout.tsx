// app/layout.tsx
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Crypto Settlement Risk Engine',
  description: 'Risk-aware crypto escrow and settlement engine',
  icons: {
    icon: '/logo.svg',
  },
}

import { Providers } from '@/components/providers'
import Navigation from './components/Navigation'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-950 text-slate-100`}>
        <Providers>
          <Navigation />

          <main className="min-h-screen">
            {children}
          </main>
        </Providers>

        <footer className="mt-12 border-t border-slate-800">
          <div className="container mx-auto px-4 py-8 sm:px-6 lg:px-8">
            <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
              <span className="text-sm font-semibold text-slate-300">Crypto Settlement Risk Engine</span>
              <p className="text-sm text-slate-500">
                A risk-aware crypto escrow research project. Not production financial infrastructure.
              </p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  )
}
