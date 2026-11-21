import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/server/cron-auth";
import { runWeatherAlerts } from "@/lib/server/weather-alerts";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Alertas meteorológicas del SMN. Lo llama GitHub Actions cada 30 min
 * (.github/workflows/weather-alerts.yml) con `Authorization: Bearer $CRON_SECRET`:
 * el cron de Vercel en Hobby corre solo una vez por día.
 * `?dryRun=1` devuelve qué se mandaría sin mandar nada.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const result = await runWeatherAlerts(new Date(), { dryRun });
  console.log("[cron] alertas del clima", { ...result, preview: result.preview?.length });
  return NextResponse.json({ ok: true, ...result });
}
