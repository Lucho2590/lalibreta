import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const body = (await req.json().catch(() => null)) as
    | { shareId?: string }
    | null;
  if (!body?.shareId) {
    return NextResponse.json({ error: "Falta shareId" }, { status: 400 });
  }

  const ref = adminDb().collection("accountShares").doc(body.shareId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No existe" }, { status: 404 });
  }
  const data = snap.data() as { ownerUid: string };
  if (data.ownerUid !== user.uid) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  await ref.update({
    status: "revoked",
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
}
