import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { sendEmail } from "@/lib/server/resend";
import { renderShareResponseEmail } from "@/lib/server/mail-templates";

export const runtime = "nodejs";

interface RespondBody {
  sharedExpenseId?: string;
  response?: "accepted" | "rejected";
}

export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const body = (await req.json().catch(() => null)) as RespondBody | null;
  if (!body?.sharedExpenseId || !body.response) {
    return NextResponse.json(
      { error: "Falta sharedExpenseId o response" },
      { status: 400 },
    );
  }
  if (body.response !== "accepted" && body.response !== "rejected") {
    return NextResponse.json({ error: "response inválido" }, { status: 400 });
  }

  const ref = adminDb().collection("sharedExpenses").doc(body.sharedExpenseId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No existe" }, { status: 404 });
  }
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) {
    return NextResponse.json({ error: "No data" }, { status: 500 });
  }

  const participants = (data.participants as Array<{
    uid: string | null;
    email: string;
    displayName: string | null;
    percentage: number;
    amount: number;
    status: string;
    respondedAt?: { toDate(): Date } | null;
  }>) ?? [];

  const userEmail = user.email?.toLowerCase() ?? null;
  let idx = participants.findIndex((p) => p.uid === user.uid);
  if (idx === -1 && userEmail) {
    idx = participants.findIndex(
      (p) => !p.uid && p.email.toLowerCase() === userEmail,
    );
  }
  if (idx === -1) {
    return NextResponse.json(
      { error: "No sos participante de este gasto" },
      { status: 403 },
    );
  }
  if (participants[idx].status === "owner") {
    return NextResponse.json(
      { error: "El owner no puede aceptar/rechazar su propio gasto" },
      { status: 400 },
    );
  }

  const updatedParticipants = participants.map((p, i) =>
    i === idx
      ? {
          ...p,
          uid: user.uid,
          status: body.response,
          respondedAt: new Date(),
        }
      : p,
  );

  // Mantener participantUids sincronizado para que el dueño y otros queries por uid
  // sigan viéndolo. Acumula uids únicos de todos los participantes ya con uid.
  const participantUids = Array.from(
    new Set(
      updatedParticipants
        .map((p) => p.uid)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  );

  await ref.update({
    participants: updatedParticipants,
    participantUids,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Avisar al owner por mail (best-effort).
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const ownerEmail = data.ownerEmail as string | undefined;
  if (ownerEmail) {
    const { subject, html, text } = renderShareResponseEmail({
      to: ownerEmail,
      responderName:
        participants[idx].displayName || participants[idx].email,
      responderEmail: participants[idx].email,
      response: body.response,
      description: (data.description as string) ?? "",
      totalAmount: data.totalAmount as number,
      responderAmount: participants[idx].amount,
      appUrl,
      sharedExpenseId: body.sharedExpenseId,
    });
    void sendEmail({ to: ownerEmail, subject, html, text });
  }

  return NextResponse.json({ ok: true });
}
