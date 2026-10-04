// Every env var this app uses (NEXT_PUBLIC_RISK_ESCROW_ADDRESS,
// DATABASE_URL, RISK_SERVICE_URL, ...) lives in the monorepo root's
// .env.local - the same file contracts/scripts/deploy.js writes to and
// hardhat/the Go indexer read from. Next.js only auto-loads .env* from
// its own app directory, so `apps/web/.env.local` is a symlink to the
// root file (see that symlink) rather than a real file here - this way
// Next's own normal env-loading path just finds it, instead of racing a
// custom `loadEnvConfig()` call against Next's internal one (which was
// tried here first and silently lost that race: process.env had the
// right values immediately after the call, but requests still saw
// stale/empty ones once the dev server was actually running).

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Configure Turbopack - add empty object to satisfy Next.js
  // In Next.js 16+, turbopack is a top-level key, not under experimental
  turbopack: {
    // Empty configuration - this tells Next.js we accept the default Turbopack behavior
  },
  
  // Webpack configuration will be ignored when Turbopack is enabled
  // But we keep it for compatibility
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        fs: false,
        net: false,
        tls: false,
        '@react-native-async-storage/async-storage': false,
        'pino-pretty': false,
        crypto: false,
        stream: false,
      };
    }

    // RainbowKit's Coinbase Smart Wallet connector lazily imports optional
    // x402 payment-protocol packages that aren't (and don't need to be)
    // installed. Stub them out so webpack doesn't fail resolving them.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@x402/core/client': false,
      '@x402/evm/exact/client': false,
      '@x402/evm/upto/client': false,
      '@x402/svm/exact/client': false,
      '@x402/evm': false,
      '@x402/svm': false,
    };

    return config;
  },
}

module.exports = nextConfig;
