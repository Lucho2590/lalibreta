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
    if (err instanceof UnauthorizedError) {
      return unauthorizedResponse(err.message);
    }
    throw err;
  }

  if (!user.email) {
    return NextResponse.json(
      { error: "El usuario no tiene email asociado" },
      { status: 400 },
    );
  }

  const ref = adminDb().collection("users").doc(user.uid);
  const snap = await ref.get();
  const emailNormalized = user.email.toLowerCase();

  if (!snap.exists) {
    await ref.set({
      email: emailNormalized,
      displayName: user.name ?? null,
      photoURL: user.picture ?? null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ created: true });
  }

  // Idempotente: actualizar solo si cambió algo (email o display).
  const data = snap.data() ?? {};
  const patch: Record<string, unknown> = {};
  if (data.email !== emailNormalized) patch.email = emailNormalized;
  if (user.name && data.displayName !== user.name) patch.displayName = user.name;
  if (user.picture && data.photoURL !== user.picture) patch.photoURL = user.picture;

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = FieldValue.serverTimestamp();
    await ref.update(patch);
    return NextResponse.json({ created: false, updated: true });
  }
  return NextResponse.json({ created: false, updated: false });
}
