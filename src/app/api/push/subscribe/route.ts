import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { savePushSubscription } from "@/lib/server/notifications";

export const runtime = "nodejs";

const schema = z.object({
  subscription: z.object({
    endpoint: z.url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(200) }),
  }),
});

/** Guarda la suscripción push de este dispositivo. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Suscripción inválida" }, { status: 400 });
  const id = await savePushSubscription(user.uid, parsed.data.subscription, req.headers.get("user-agent"));
  return NextResponse.json({ ok: true, id });
}
