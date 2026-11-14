import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { ShareAccessError, loadSharedMovements } from "@/lib/server/shared-movements";
import { currentMonthKey, isMonthKey } from "@/lib/server/time";

export const runtime = "nodejs";

/** Movimientos de una cuenta compartida conmigo (lo que el dueño me deja ver). */
export async function GET(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const url = new URL(req.url);
  const shareId = url.searchParams.get("shareId");
  const month = url.searchParams.get("month") ?? currentMonthKey();
  if (!shareId || !isMonthKey(month)) return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  try {
    return NextResponse.json(await loadSharedMovements(user.uid, shareId, month));
  } catch (err) {
    if (err instanceof ShareAccessError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
}
