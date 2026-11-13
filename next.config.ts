import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // El login de Google se sirve desde nuestro dominio (ver src/lib/firebase/client.ts).
  async rewrites() {
    const firebaseHost = `https://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "cashflow-fd2c8.firebaseapp.com"}`;
    return [
      { source: "/__/auth/:path*", destination: `${firebaseHost}/__/auth/:path*` },
    ];
  },
  async headers() {
    return [
      {
        // El service worker siempre fresco: si no, una versión vieja queda pegada.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
