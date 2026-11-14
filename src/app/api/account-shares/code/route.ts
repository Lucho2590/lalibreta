import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { createShareCode } from "@/lib/server/sharing";

export const runtime = "nodejs";

/** Genera un código de un solo uso (24 h) para compartir una cuenta propia. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const body = (await req.json().catch(() => null)) as { accountId?: string } | null;
  const accountId = body?.accountId?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "Falta accountId" }, { status: 400 });
  }

  const snap = await adminDb().doc(`users/${user.uid}/accounts/${accountId}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
  }
  const account = snap.data() as { name: string; type: string; active?: boolean };
  if (account.active === false) {
    return NextResponse.json({ error: "La cuenta está archivada" }, { status: 400 });
  }
  if (account.type === "reserve") {
    return NextResponse.json(
      { error: "Las cobachas no se comparten; compartí la cuenta madre." },
      { status: 400 },
    );
  }

  const { code, expiresAt, message } = await createShareCode(user.uid, [
    { id: accountId, name: account.name },
  ]);
  return NextResponse.json({ code, expiresAt: expiresAt.toISOString(), message });
}
