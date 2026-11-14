import { NextResponse } from "next/server";
import { adminErrorResponse, requireAdmin } from "@/lib/server/admin";
import { loadAdminOverview } from "@/lib/server/admin-data";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
  } catch (err) {
    const res = adminErrorResponse(err);
    if (res) return res;
    throw err;
  }
  return NextResponse.json(await loadAdminOverview());
}
