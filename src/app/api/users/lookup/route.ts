import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return unauthorizedResponse(err.message);
    }
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const emailRaw = searchParams.get("email");
  if (!emailRaw) {
    return NextResponse.json(
      { error: "Falta query param `email`" },
      { status: 400 },
    );
  }
  const email = emailRaw.trim().toLowerCase();
  if (!/^.+@.+\..+$/.test(email)) {
    return NextResponse.json({ error: "Email inválido" }, { status: 400 });
  }

  const snap = await adminDb()
    .collection("users")
    .where("email", "==", email)
    .limit(1)
    .get();

  if (snap.empty) {
    return NextResponse.json(
      { error: "No encontrado", email },
      { status: 404 },
    );
  }

  const doc = snap.docs[0];
  const data = doc.data();
  return NextResponse.json({
    uid: doc.id,
    email: data.email,
    displayName: data.displayName ?? null,
    photoURL: data.photoURL ?? null,
  });
}
