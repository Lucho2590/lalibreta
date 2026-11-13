import type { MetadataRoute } from "next";
import { BRAND_COLOR } from "@/lib/pwa/icon-art";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "La Libreta",
    short_name: "La Libreta",
    description: "Tus gastos, tarjetas y cuotas, con un agente que te ayuda por WhatsApp.",
    lang: "es-AR",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f6f5fb",
    theme_color: BRAND_COLOR,
    categories: ["finance", "productivity"],
    icons: [
      { src: "/pwa-icon/192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/pwa-icon/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Movimientos", url: "/movimientos" },
      { name: "Cuentas", url: "/cuentas" },
    ],
  };
}
