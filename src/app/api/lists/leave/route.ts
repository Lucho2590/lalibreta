import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { ListError, leaveListNode, loadActor } from "@/lib/server/lists";

export const runtime = "nodejs";

const schema = z.object({ nodeId: z.string().min(1) });

/** Alguien a quien le compartieron una lista se baja (de ella y de todo lo de adentro). */
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
    const actor = await loadActor(user.uid);
    await leaveListNode({ ...actor, email: actor.email || (user.email ?? "").toLowerCase() }, parsed.data.nodeId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ListError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[lists/leave]", err);
    return NextResponse.json({ error: "No se pudo completar" }, { status: 500 });
  }
}
