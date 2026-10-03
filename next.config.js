const path = require('path')

function hasModule(name) {
  try {
    require.resolve(`${name}/package.json`)
    return true
  } catch {
    return false
  }
}

const useSiteTelemetry = process.env.NEXT_PUBLIC_SITE_TELEMETRY === '1' && hasModule('@vercel/analytics') && hasModule('@vercel/speed-insights')

// When telemetry is omitted (the OSS/local default), the `@vercel/*` imports are
// aliased to a no-op shim so the optional dependencies aren't required to build.
// Next.js 16 defaults to Turbopack, so the same alias is provided for both the
// Turbopack (`turbopack.resolveAlias`, project-relative paths) and webpack
// (`--webpack`, absolute paths) code paths.
const shimRelative = './src/shims/vercel-telemetry.tsx'
const shimAbsolute = path.resolve(__dirname, 'src/shims/vercel-telemetry.tsx')

module.exports = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    resolveAlias: useSiteTelemetry
      ? {}
      : {
          '@vercel/analytics/react': shimRelative,
          '@vercel/speed-insights/next': shimRelative,
        },
  },
  webpack: (config) => {
    if (!useSiteTelemetry) {
      config.resolve.alias = {
        ...config.resolve.alias,
        '@vercel/analytics/react': shimAbsolute,
        '@vercel/speed-insights/next': shimAbsolute,
      }
    }
    return config
  },
}
