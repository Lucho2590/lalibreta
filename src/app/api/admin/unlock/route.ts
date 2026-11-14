import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { unlockAdmin } from "@/lib/server/admin";

export const runtime = "nodejs";

const schema = z.object({ pin: z.string().regex(/^\d{4}$/) });

/** PIN del panel de administrador → token de sesión (12 h). */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "PIN incorrecto" }, { status: 401 });
  const r = await unlockAdmin(user, parsed.data.pin);
  if (r.ok) return NextResponse.json({ token: r.token, expiresAt: r.expiresAt });
  return NextResponse.json(
    {
      error: r.reason === "locked" ? `Demasiados intentos. Probá en ${r.retryInMinutes} min.` : "PIN incorrecto",
    },
    { status: r.reason === "locked" ? 429 : 401 },
  );
}
