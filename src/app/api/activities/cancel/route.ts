import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { ActivityError, cancelActivityAdmin } from "@/lib/server/activities";

export const runtime = "nodejs";

/** El dueño cancela la actividad: se borra y se les avisa a los invitados. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const body = (await req.json().catch(() => null)) as { activityId?: string } | null;
  if (!body?.activityId) return NextResponse.json({ error: "Falta activityId" }, { status: 400 });
  try {
    const result = await cancelActivityAdmin(user.uid, body.activityId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ActivityError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
