import type { NextConfig } from "next";

// Production only: dev needs eval for hot reload. Nothing here is exploitable today (no XSS sink was
// found in review) — it limits the damage if one ever appears. See docs/DECISIONS.md.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // the shop's own site: the approval email designs (shown in Settings in a sandboxed frame) load their logos from it
  "img-src 'self' data: blob: https://selectivecap.com https://*.selectivecap.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  poweredByHeader: false,
  // The dev-tools "N" badge floats over the bottom-right tab ("More") on a phone-sized window and swallows its taps,
  // which breaks the local browser tests. It is a development widget only; production builds never had it.
  devIndicators: false,
  serverExternalPackages: ["pg"],
  // The merchant import is one server action carrying up to 2,000 rows; the 1 MB default can be too small.
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // client UUIDs are in URLs
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
