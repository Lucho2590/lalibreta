import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDailyReminders } from "@/lib/server/daily-reminders";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Lo llama Vercel Cron una vez por día (ver vercel.json) con
 * `Authorization: Bearer $CRON_SECRET`.
 */
const authorized = (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
};

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const result = await runDailyReminders();
  console.log("[cron] avisos del día", result);
  return NextResponse.json({ ok: true, ...result });
}
