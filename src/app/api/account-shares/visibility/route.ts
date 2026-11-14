import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { ShareAccessError, setShareVisibility } from "@/lib/server/shared-movements";

export const runtime = "nodejs";

const schema = z.object({ shareId: z.string().min(1), visibility: z.enum(["own", "all"]) });

/** Solo el DUEÑO de la cuenta decide qué ve la persona con la que la compartió. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    await setShareVisibility(user.uid, parsed.data.shareId, parsed.data.visibility);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ShareAccessError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
}
