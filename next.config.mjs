/** @type {import('next').NextConfig} */

// Build connect-src and frame-src dynamically to include the backend URL
const connectSrcParts = [
  "'self'",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  "https://*.up.railway.app",
];
const frameSrcParts = [
  "'self'",
  "https://*.up.railway.app",
  "https://disk.yandex.ru",
];
const backendUrl = process.env.NEXT_PUBLIC_API_URL || "";
if (backendUrl) {
  try {
    const origin = new URL(backendUrl).origin;
    if (!connectSrcParts.includes(origin)) {
      connectSrcParts.push(origin);
    }
    if (!frameSrcParts.includes(origin)) {
      frameSrcParts.push(origin);
    }
  } catch { /* invalid URL, skip */ }
}

const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['ioredis'],
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
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob:",
              `connect-src ${connectSrcParts.join(" ")}`,
              `frame-src ${frameSrcParts.join(" ")}`,
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
      // Allow same-origin iframe embedding for PDF/document preview
      {
        source: "/api/sources/download",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
      // Allow /help to be embedded as iframe inside the app (support modal)
      {
        source: "/help",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
