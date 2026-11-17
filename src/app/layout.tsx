import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Suspense } from "react";
import "./globals.css";
import { AuthProvider } from "@/hooks/use-auth";
import { AppShell } from "@/components/layout/app-shell";
import { Toaster } from "@/components/ui/sonner";

// Fuentes guardadas en el repo (versión variable, de Fontsource): con
// next/font/google el build de Vercel a veces fallaba al bajarlas.
const sans = localFont({
  src: "./fonts/plus-jakarta-sans.woff2",
  variable: "--font-sans",
  weight: "200 800",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/jetbrains-mono.woff2",
  variable: "--font-mono",
  weight: "100 800",
  display: "swap",
});

export const metadata: Metadata = {
  title: "La Libreta",
  description: "Gestión de gastos personales con tarjetas en cuotas",
  applicationName: "La Libreta",
  // iOS: abrir sin la barra de Safari cuando se agrega a la pantalla de inicio.
  appleWebApp: { capable: true, title: "La Libreta", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#14161f" },
  ],
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="es"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-app">
        <AuthProvider>
          <Suspense fallback={null}>
            <AppShell>{children}</AppShell>
          </Suspense>
        </AuthProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
