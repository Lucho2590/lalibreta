import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { sendEmail } from "@/lib/server/resend";
import { renderAccountShareEmail } from "@/lib/server/mail-templates";

export const runtime = "nodejs";

interface Body {
  accountId?: string;
  granteeEmail?: string;
}

export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  if (!user.email) {
    return NextResponse.json({ error: "Tu user no tiene email" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const accountId = body?.accountId?.trim();
  const granteeEmail = body?.granteeEmail?.trim().toLowerCase();
  if (!accountId || !granteeEmail) {
    return NextResponse.json(
      { error: "Falta accountId o granteeEmail" },
      { status: 400 },
    );
  }
  if (granteeEmail === user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "No te podés compartir una cuenta a vos mismo" },
      { status: 400 },
    );
  }

  // Verificar que la cuenta existe y es del owner.
  const accountRef = adminDb()
    .collection(`users/${user.uid}/accounts`)
    .doc(accountId);
  const accountSnap = await accountRef.get();
  if (!accountSnap.exists) {
    return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
  }
  const account = accountSnap.data() as {
    name: string;
    icon?: string | null;
    type: string;
  };

  // Buscar al grantee en users (puede no estar registrado).
  const granteeSnap = await adminDb()
    .collection("users")
    .where("email", "==", granteeEmail)
    .limit(1)
    .get();
  let granteeUid: string | null = null;
  let granteeDisplayName: string | null = null;
  if (!granteeSnap.empty) {
    const d = granteeSnap.docs[0];
    granteeUid = d.id;
    granteeDisplayName = (d.data().displayName as string | null) ?? null;
  }

  // Evitar duplicados: si ya hay un share activo para esta cuenta + email, devolver el existente.
  const existing = await adminDb()
    .collection("accountShares")
    .where("ownerUid", "==", user.uid)
    .where("accountId", "==", accountId)
    .where("granteeEmail", "==", granteeEmail)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (!existing.empty) {
    return NextResponse.json({
      ok: true,
      shareId: existing.docs[0].id,
      alreadyExists: true,
    });
  }

  const ref = adminDb().collection("accountShares").doc();
  await ref.set({
    ownerUid: user.uid,
    ownerEmail: user.email.toLowerCase(),
    ownerDisplayName: user.name ?? null,
    accountId,
    accountName: account.name,
    accountIcon: account.icon ?? null,
    accountType: account.type,
    granteeEmail,
    granteeUid,
    granteeDisplayName,
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Mail al grantee.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { subject, html, text } = renderAccountShareEmail({
    to: granteeEmail,
    ownerName: user.name ?? user.email,
    ownerEmail: user.email,
    accountName: account.name,
    appUrl,
    recipientIsRegistered: !!granteeUid,
  });
  void sendEmail({ to: granteeEmail, subject, html, text });

  return NextResponse.json({ ok: true, shareId: ref.id });
}
