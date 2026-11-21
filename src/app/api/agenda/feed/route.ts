import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { getOrCreateFeedToken, resetFeedToken } from "@/lib/server/calendar-feed";

export const runtime = "nodejs";

/**
 * Link privado de la agenda para suscribirse desde otro calendario.
 * POST {} → el link (lo crea si no existe). POST { reset: true } → uno nuevo.
 */
export async function POST(req: Request) {
  try {
    const user = await getAuthedUser(req);
    const body = (await req.json().catch(() => ({}))) as { reset?: boolean };
    const token = body.reset ? await resetFeedToken(user.uid) : await getOrCreateFeedToken(user.uid);
    const origin = new URL(req.url).origin;
    return NextResponse.json({ token, url: `${origin}/api/agenda/ics/${token}.ics` });
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    console.error("[agenda] feed", err);
    return NextResponse.json({ error: "No se pudo completar" }, { status: 500 });
  }
}
