import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { ListError, loadActor, shareListNode } from "@/lib/server/lists";

export const runtime = "nodejs";

const schema = z.object({
  nodeId: z.string().min(1),
  shares: z
    .array(
      z.object({
        uid: z.string().nullish(),
        email: z.string().email(),
        displayName: z.string().nullish(),
        photoURL: z.string().nullish(),
        role: z.enum(["view", "edit"]),
      }),
    )
    .max(50),
});

/** El dueño guarda con quién comparte un grupo o lista (y todo lo de adentro). */
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
    const result = await shareListNode(
      { ...actor, email: actor.email || (user.email ?? "").toLowerCase(), displayName: actor.displayName ?? user.name },
      parsed.data.nodeId,
      parsed.data.shares.map((s) => ({ ...s, uid: s.uid ?? null })),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ListError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[lists/share]", err);
    return NextResponse.json({ error: "No se pudo compartir" }, { status: 500 });
  }
}
