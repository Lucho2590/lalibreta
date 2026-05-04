import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { sendEmail } from "@/lib/server/resend";
import { renderShareInviteEmail } from "@/lib/server/mail-templates";

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
    | { sharedExpenseId?: string }
    | null;
  if (!body?.sharedExpenseId) {
    return NextResponse.json({ error: "Falta sharedExpenseId" }, { status: 400 });
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
  if (data.ownerUid !== user.uid) {
    return NextResponse.json({ error: "Solo el owner puede invitar" }, { status: 403 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const ownerName =
    (data.ownerDisplayName as string | null | undefined) ||
    (data.ownerEmail as string) ||
    "Alguien";
  const totalAmount = data.totalAmount as number;
  const description = (data.description as string) ?? "";
  const date = (data.date as { toDate(): Date }).toDate();
  const participants = (data.participants as Array<{
    uid: string | null;
    email: string;
    percentage: number;
    amount: number;
    status: string;
  }>) ?? [];

  const sent: Array<{ email: string; ok: boolean; error?: string }> = [];

  for (const p of participants) {
    if (p.status === "owner") continue;
    if (!p.email) continue;
    const { subject, html, text } = renderShareInviteEmail({
      to: p.email,
      ownerName,
      ownerEmail: data.ownerEmail as string,
      description,
      totalAmount,
      participantAmount: p.amount,
      participantPercentage: p.percentage,
      date,
      appUrl,
      sharedExpenseId: body.sharedExpenseId,
      recipientIsRegistered: !!p.uid,
    });
    const r = await sendEmail({ to: p.email, subject, html, text });
    sent.push({ email: p.email, ok: r.ok, error: r.error });
  }

  return NextResponse.json({ sent });
}
