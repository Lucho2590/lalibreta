import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { sendEmail } from "@/lib/server/resend";
import { renderApprovalDecisionEmail } from "@/lib/server/mail-templates";
import {
  createTransactionAdmin,
  type ServerAccount,
} from "@/lib/server/transactions-admin";

export const runtime = "nodejs";

interface Body {
  approvalId?: string;
  decision?: "approved" | "rejected";
  categoryId?: string;
  rejectReason?: string;
}

export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.approvalId || !body.decision) {
    return NextResponse.json(
      { error: "Faltan approvalId o decision" },
      { status: 400 },
    );
  }
  if (body.decision === "approved" && !body.categoryId) {
    return NextResponse.json(
      { error: "Falta categoryId para aprobar" },
      { status: 400 },
    );
  }

  const approvalRef = adminDb().collection("pendingApprovals").doc(body.approvalId);
  const approvalSnap = await approvalRef.get();
  if (!approvalSnap.exists) {
    return NextResponse.json({ error: "No existe" }, { status: 404 });
  }
  const approval = approvalSnap.data() as {
    ownerUid: string;
    granteeEmail: string;
    granteeDisplayName: string | null;
    accountId: string;
    accountName: string;
    description: string;
    totalAmount: number;
    purchaseDate: { toDate(): Date };
    installments: number;
    cardClosedAtPurchase: boolean;
    status: string;
  };

  if (approval.ownerUid !== user.uid) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }
  if (approval.status !== "pending") {
    return NextResponse.json(
      { error: "Esta aprobación ya fue resuelta" },
      { status: 400 },
    );
  }

  let approvedTransactionId: string | null = null;

  if (body.decision === "approved") {
    // Validar categoría del owner.
    const catRef = adminDb()
      .collection(`users/${user.uid}/categories`)
      .doc(body.categoryId!);
    const catSnap = await catRef.get();
    if (!catSnap.exists) {
      return NextResponse.json(
        { error: "Categoría no encontrada" },
        { status: 404 },
      );
    }

    // Leer la cuenta.
    const accountRef = adminDb()
      .collection(`users/${user.uid}/accounts`)
      .doc(approval.accountId);
    const accountSnap = await accountRef.get();
    if (!accountSnap.exists) {
      return NextResponse.json(
        { error: "La cuenta original ya no existe" },
        { status: 404 },
      );
    }
    const accountData = accountSnap.data() as {
      type: ServerAccount["type"];
      defaultClosingDay?: number;
      defaultDueDay?: number;
    };
    const account: ServerAccount = {
      id: approval.accountId,
      type: accountData.type,
      defaultClosingDay: accountData.defaultClosingDay,
      defaultDueDay: accountData.defaultDueDay,
    };

    approvedTransactionId = await createTransactionAdmin({
      ownerUid: user.uid,
      account,
      accountId: approval.accountId,
      categoryId: body.categoryId!,
      description: approval.description,
      totalAmount: approval.totalAmount,
      purchaseDate: approval.purchaseDate.toDate(),
      kind: "expense",
      installments: approval.installments,
      cardClosedAtPurchase: approval.cardClosedAtPurchase,
    });
  }

  await approvalRef.update({
    status: body.decision,
    approvedTransactionId: approvedTransactionId ?? null,
    approvedCategoryId: body.decision === "approved" ? body.categoryId! : null,
    rejectReason: body.decision === "rejected" ? body.rejectReason ?? null : null,
    respondedAt: FieldValue.serverTimestamp(),
  });

  // Mail al grantee.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { subject, html, text } = renderApprovalDecisionEmail({
    to: approval.granteeEmail,
    ownerName: user.name ?? user.email ?? "El dueño",
    decision: body.decision,
    accountName: approval.accountName,
    description: approval.description,
    totalAmount: approval.totalAmount,
    rejectReason: body.rejectReason ?? null,
    appUrl,
  });
  void sendEmail({ to: approval.granteeEmail, subject, html, text });

  return NextResponse.json({
    ok: true,
    approvedTransactionId: approvedTransactionId ?? undefined,
  });
}
