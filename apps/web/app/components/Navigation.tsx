// app/components/Navigation.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import WalletConnectButton from '@/components/common/WalletConnectButton';
import { IndexerHealthBadge } from '@/components/system/IndexerHealthBadge';

export default function Navigation() {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navLinks = [
    { name: 'Overview', href: '/' },
    { name: 'Risk', href: '/risk' },
    { name: 'Models', href: '/models' },
    { name: 'Escrows', href: '/escrow' },
  ];

  function isActive(href: string): boolean {
    return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-slate-800 bg-slate-950">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          {/* Logo */}
          <div className="flex items-center">
            <Link href="/" className="flex items-center gap-2.5">
              <svg className="h-7 w-7" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="64" height="64" rx="14" fill="#0b1220"/>
                <defs><clipPath id="tail"><rect x="0" y="0" width="26" height="64"/></clipPath></defs>
                <path d="M9 47 C21 47 24 17 32 17 C40 17 43 47 55 47 Z" fill="#3987e5" clipPath="url(#tail)"/>
                <path d="M9 47 C21 47 24 17 32 17 C40 17 43 47 55 47" stroke="#e2e8f0" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="text-sm font-semibold text-slate-100">Risk Engine</span>
            </Link>

            {/* Desktop Navigation */}
            <div className="ml-8 hidden md:flex items-center space-x-5">
              {navLinks.map((link) => (
                <Link
                  key={link.name}
                  href={link.href}
                  className={`text-sm font-medium transition-colors hover:text-slate-100 ${
                    isActive(link.href) ? 'text-slate-100' : 'text-slate-400'
                  }`}
                >
                  {link.name}
                </Link>
              ))}
            </div>
          </div>

          {/* Right side: Wallet connection */}
          <div className="flex items-center gap-4">
            <div className="hidden sm:block">
              <IndexerHealthBadge />
            </div>
            <WalletConnectButton />

            {/* Mobile Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden inline-flex items-center justify-center rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <span className="sr-only">Open menu</span>
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {isMobileMenuOpen && (
          <div className="md:hidden border-t border-slate-800 py-4">
            <div className="flex flex-col space-y-1">
              {navLinks.map((link) => (
                <Link
                  key={link.name}
                  href={link.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={`rounded-lg px-4 py-2 text-sm ${
                    isActive(link.href)
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  {link.name}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
