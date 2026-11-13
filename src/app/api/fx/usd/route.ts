import { NextResponse } from "next/server";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { getUsdRate } from "@/lib/server/fx";

export const runtime = "nodejs";

/** Cotización oficial del dólar (BCRA). ?date=YYYY-MM-DD opcional. */
export async function GET(req: Request) {
  try {
    await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  try {
    return NextResponse.json(await getUsdRate(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined));
  } catch (err) {
    console.error("[fx] error", err);
    return NextResponse.json({ error: "No se pudo obtener la cotización" }, { status: 502 });
  }
}
