/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    turbo: {},
    serverActions: {
      bodySizeLimit: '2mb'
    }
  }
}

export default nextConfig

