import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { ActivityError, respondToActivity } from "@/lib/server/activities";

export const runtime = "nodejs";

/** Un invitado dice si va o no (también sirve para bajarse de una que ya aceptó). */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const body = (await req.json().catch(() => null)) as
    | { activityId?: string; response?: string }
    | null;
  if (!body?.activityId || (body.response !== "accepted" && body.response !== "rejected")) {
    return NextResponse.json({ error: "Falta activityId o response" }, { status: 400 });
  }
  try {
    await respondToActivity(user, body.activityId, body.response);
  } catch (err) {
    if (err instanceof ActivityError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return NextResponse.json({ ok: true });
}
