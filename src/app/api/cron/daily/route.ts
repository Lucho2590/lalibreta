import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/server/cron-auth";
import { runDailyReminders } from "@/lib/server/daily-reminders";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Lo llama Vercel Cron una vez por día (ver vercel.json) con
 * `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const result = await runDailyReminders();
  console.log("[cron] avisos del día", result);
  return NextResponse.json({ ok: true, ...result });
}
