import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { sendEmail } from "@/lib/server/resend";
import { renderPendingApprovalSubmittedEmail } from "@/lib/server/mail-templates";
import { createTransactionAdmin } from "@/lib/server/transactions-admin";
import { loadAccounts, loadCategories, toServerAccount } from "@/lib/server/queries-admin";
import { notifyUser } from "@/lib/server/sharing";
import { formatMoney } from "@/lib/format";

export const runtime = "nodejs";

interface Body {
  shareId?: string;
  description?: string;
  totalAmount?: number;
  purchaseDate?: string;     // YYYY-MM-DD
  installments?: number;
  cardClosedAtPurchase?: boolean;
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
  if (!body?.shareId || !body.purchaseDate) {
    return NextResponse.json(
      { error: "Faltan campos obligatorios" },
      { status: 400 },
    );
  }
  const totalAmount = Number(body.totalAmount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return NextResponse.json({ error: "Monto inválido" }, { status: 400 });
  }
  const installments = Math.max(1, Math.min(36, Number(body.installments ?? 1)));

  const shareRef = adminDb().collection("accountShares").doc(body.shareId);
  const shareSnap = await shareRef.get();
  if (!shareSnap.exists) {
    return NextResponse.json({ error: "Share no encontrado" }, { status: 404 });
  }
  const share = shareSnap.data() as {
    ownerUid: string;
    ownerEmail: string;
    granteeUid: string | null;
    granteeEmail: string;
    accountId: string;
    accountName: string;
    status: string;
    mode?: "direct" | "approval";
  };
  if (share.granteeUid !== user.uid) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }
  if (share.status !== "active") {
    return NextResponse.json(
      { error: "El acceso a esta cuenta fue revocado" },
      { status: 403 },
    );
  }

  const purchaseDate = new Date(`${body.purchaseDate}T12:00:00`);

  // Compartidas por WhatsApp (mode "direct"): el gasto entra directo a la
  // cuenta del dueño, en su categoría "Otros", y se le avisa.
  if (share.mode === "direct") {
    const [ownerAccounts, ownerCats] = await Promise.all([
      loadAccounts(share.ownerUid),
      loadCategories(share.ownerUid),
    ]);
    const account = ownerAccounts.find((a) => a.id === share.accountId);
    const category =
      ownerCats.find((c) => c.kind === "expense" && /^otro/i.test(c.name)) ??
      ownerCats.find((c) => c.kind === "expense");
    if (!account || !category) {
      return NextResponse.json({ error: "La cuenta compartida ya no existe" }, { status: 404 });
    }
    const name = user.name ?? user.email.split("@")[0];
    const txId = await createTransactionAdmin({
      ownerUid: share.ownerUid,
      account: toServerAccount(account),
      accountId: account.id,
      categoryId: category.id,
      description: body.description ?? "",
      totalAmount,
      purchaseDate,
      kind: "expense",
      installments,
      cardClosedAtPurchase: !!body.cardClosedAtPurchase,
      createdBy: { uid: user.uid, name },
    });
    void notifyUser(
      share.ownerUid,
      `🧾 *${name}* cargó *${body.description || "un gasto"}* por *${formatMoney(totalAmount)}* con tu *${share.accountName}*.`,
    );
    return NextResponse.json({ ok: true, transactionId: txId, direct: true });
  }

  const approvalRef = adminDb().collection("pendingApprovals").doc();
  await approvalRef.set({
    ownerUid: share.ownerUid,
    ownerEmail: share.ownerEmail,
    granteeUid: user.uid,
    granteeEmail: user.email.toLowerCase(),
    granteeDisplayName: user.name ?? null,
    accountId: share.accountId,
    accountName: share.accountName,
    shareId: body.shareId,
    description: body.description ?? "",
    totalAmount,
    purchaseDate: Timestamp.fromDate(purchaseDate),
    installments,
    cardClosedAtPurchase: !!body.cardClosedAtPurchase,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { subject, html, text } = renderPendingApprovalSubmittedEmail({
    to: share.ownerEmail,
    granteeName: user.name ?? user.email,
    granteeEmail: user.email,
    accountName: share.accountName,
    description: body.description ?? "",
    totalAmount,
    installments,
    date: purchaseDate,
    appUrl,
  });
  void sendEmail({ to: share.ownerEmail, subject, html, text });

  return NextResponse.json({ ok: true, approvalId: approvalRef.id });
}
