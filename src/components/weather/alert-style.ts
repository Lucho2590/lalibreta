import type { AlertLevel } from "@/lib/domain/weather";

/** Colores de las alertas del SMN (amarilla / naranja / roja). */
export const ALERT_STYLE: Record<AlertLevel, string> = {
  amarilla: "bg-yellow-100 text-yellow-950 ring-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-100 dark:ring-yellow-500/40",
  naranja: "bg-orange-100 text-orange-950 ring-orange-300 dark:bg-orange-500/15 dark:text-orange-100 dark:ring-orange-500/40",
  roja: "bg-red-100 text-red-950 ring-red-300 dark:bg-red-500/15 dark:text-red-100 dark:ring-red-500/40",
};
