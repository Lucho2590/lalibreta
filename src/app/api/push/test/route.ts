import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { notify } from "@/lib/server/notifications";

export const runtime = "nodejs";

/** Aviso de prueba (botón "Probar" en la configuración de notificaciones). */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const r = await notify(user.uid, {
    kind: "test",
    title: "¡Las notificaciones andan! 🎉",
    body: "Así te vamos a avisar de vencimientos, fijos y cuentas compartidas.",
    url: "/notificaciones",
  });
  return NextResponse.json({ ok: r.stored, pushed: r.pushed });
}
