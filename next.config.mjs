/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: [
    'ioredis',
    'isomorphic-dompurify',
    'jsdom',
    'cssstyle',
    '@asamuzakjp/css-color',
    '@csstools/css-calc',
    '@csstools/css-color-parser',
    '@csstools/css-parser-algorithms',
    '@csstools/css-tokenizer',
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: '30mb',
    },
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('ioredis');
    }
    return config;
  },
  // CSP is set dynamically in middleware.ts (per-request nonce)
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        source: "/api/sources/download",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      {
        source: "/help",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
