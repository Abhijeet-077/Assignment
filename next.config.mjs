/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    turbo: {},
    serverActions: {
      bodySizeLimit: '2mb'
    }
  },
  output: 'standalone',
  trailingSlash: false,
  webpack: (config, { dev }) => {
    if (dev) {
      // Avoid filesystem rename ENOENT warnings by keeping the cache in memory during development
      config.cache = { type: 'memory' };
    }
    return config;
  }
}

export default nextConfig

