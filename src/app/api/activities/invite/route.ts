import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { inviteToActivity } from "@/lib/server/activities";

export const runtime = "nodejs";

/** El dueño avisa a los invitados (todos los pendientes, o solo los emails nuevos). */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const body = (await req.json().catch(() => null)) as { activityId?: string; emails?: string[] } | null;
  if (!body?.activityId) return NextResponse.json({ error: "Falta activityId" }, { status: 400 });

  const snap = await adminDb().collection("activities").doc(body.activityId).get();
  if (!snap.exists) return NextResponse.json({ error: "No existe" }, { status: 404 });
  if (snap.data()?.ownerUid !== user.uid) {
    return NextResponse.json({ error: "Solo quien la creó puede invitar" }, { status: 403 });
  }
  const emails = Array.isArray(body.emails) ? body.emails.filter((e) => typeof e === "string") : undefined;
  const result = await inviteToActivity(body.activityId, emails);
  return NextResponse.json({ ok: true, ...result });
}
