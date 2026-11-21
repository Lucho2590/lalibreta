import { NextResponse } from "next/server";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { getRates } from "@/lib/server/fx";

export const runtime = "nodejs";

/** Cotizaciones oficiales (BCRA) de todas las monedas. ?date=YYYY-MM-DD opcional. */
export async function GET(req: Request) {
  try {
    await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  try {
    return NextResponse.json(await getRates(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined));
  } catch (err) {
    console.error("[fx] error", err);
    return NextResponse.json({ error: "No se pudieron obtener las cotizaciones" }, { status: 502 });
  }
}
