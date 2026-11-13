import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { deletePushSubscription } from "@/lib/server/notifications";

export const runtime = "nodejs";

const schema = z.object({ endpoint: z.url().max(2000) });

/** Deja de mandar push a este dispositivo. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Falta el endpoint" }, { status: 400 });
  await deletePushSubscription(user.uid, parsed.data.endpoint);
  return NextResponse.json({ ok: true });
}
