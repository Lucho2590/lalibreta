import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { loadCategories } from "./queries-admin";
import { displayNameOf } from "./sharing";
import { currencyOf, isCardCredit, type AccountShare, type Currency, type Installment, type ShareVisibility } from "@/lib/domain/types";
import type { SharedMovement, SharedMovementsResponse } from "@/lib/domain/shared-movements";

/**
 * Movimientos de una cuenta compartida, vistos por el invitado. Según lo que
 * eligió el dueño (`visibility` del compartido):
 * - "own" (por defecto): solo lo que cargó el invitado.
 * - "all": todos los movimientos de la cuenta en ese mes.
 * El mes es el de pago (como en el resto de la app).
 */

export class ShareAccessError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;
const zero = (): Record<Currency, number> => ({ ARS: 0, USD: 0 });

export const visibilityOf = (share: Pick<AccountShare, "visibility">): ShareVisibility =>
  share.visibility === "all" ? "all" : "own";

/** Transacciones de la cuenta que cargó `granteeUid` (directas o aprobadas). */
const myTransactionIds = async (share: AccountShare, granteeUid: string): Promise<Set<string>> => {
  const db = adminDb();
  const [direct, approved] = await Promise.all([
    db
      .collection(`users/${share.ownerUid}/transactions`)
      .where("accountId", "==", share.accountId)
      .where("createdByUid", "==", granteeUid)
      .get(),
    db
      .collection("pendingApprovals")
      .where("granteeUid", "==", granteeUid)
      .where("shareId", "==", share.id)
      .get(),
  ]);
  const ids = new Set(direct.docs.map((d) => d.id));
  for (const a of approved.docs) {
    const txId = a.data().approvedTransactionId as string | undefined;
    if (txId) ids.add(txId);
  }
  return ids;
};

export const loadShareForGrantee = async (shareId: string, granteeUid: string): Promise<AccountShare> => {
  const snap = await adminDb().collection("accountShares").doc(shareId).get();
  const share = snap.exists ? ({ id: snap.id, ...snap.data() } as AccountShare) : null;
  if (!share || share.granteeUid !== granteeUid || share.status !== "active") {
    throw new ShareAccessError("Esa cuenta compartida no está disponible");
  }
  return share;
};

export const loadSharedMovements = async (
  granteeUid: string,
  shareId: string,
  month: string,
): Promise<SharedMovementsResponse> => {
  const share = await loadShareForGrantee(shareId, granteeUid);
  const visibility = visibilityOf(share);
  const db = adminDb();

  const [insSnap, mine, categories, ownerName] = await Promise.all([
    db
      .collection(`users/${share.ownerUid}/installments`)
      .where("accountId", "==", share.accountId)
      .where("paymentMonth", "==", month)
      .get(),
    myTransactionIds(share, granteeUid),
    loadCategories(share.ownerUid),
    share.ownerDisplayName ? Promise.resolve(share.ownerDisplayName) : displayNameOf(share.ownerUid),
  ]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  const all = insSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as unknown as Installment)
    // Pagos y transferencias de la cuenta no son "gastos": no se muestran.
    .filter((i) => i.kind === "expense" || i.kind === "income");

  const mineTotal = zero();
  const accountTotal = zero();
  let dueDate: Date | null = null;
  const items: SharedMovement[] = [];
  for (const i of all) {
    const isMine = mine.has(i.transactionId);
    const c = currencyOf(i);
    const credit = isCardCredit(i);
    const signed = i.kind === "expense" ? i.amount : -i.amount;
    accountTotal[c] += signed;
    if (isMine) mineTotal[c] += signed;
    if (!dueDate && share.accountType === "credit" && i.kind === "expense") dueDate = i.billingDate.toDate();
    if (visibility === "own" && !isMine) continue;
    items.push({
      id: i.id,
      date: i.billingDate.toDate().toISOString(),
      description: i.description || catName.get(i.categoryId) || "Gasto",
      amount: i.amount,
      currency: c,
      kind: i.kind,
      installment: i.totalInstallments > 1 ? `${i.installmentNumber}/${i.totalInstallments}` : null,
      categoryName: catName.get(i.categoryId) ?? null,
      createdByName: isMine ? null : i.createdByName ?? null,
      mine: isMine,
      credit,
    });
  }
  // Fecha de compra (en tarjetas, la cuota guarda el vencimiento): de la transacción.
  const txIds = [...new Set(all.filter((i) => items.some((x) => x.id === i.id)).map((i) => i.transactionId))];
  if (txIds.length > 0) {
    const txs = await db.getAll(...txIds.map((id) => db.doc(`users/${share.ownerUid}/transactions/${id}`)));
    const bought = new Map(
      txs.map((t) => [t.id, (t.data()?.purchaseDate as Timestamp | undefined)?.toDate().toISOString()]),
    );
    const txOf = new Map(all.map((i) => [i.id, i.transactionId]));
    for (const it of items) it.date = bought.get(txOf.get(it.id) ?? "") ?? it.date;
  }
  items.sort((a, b) => b.date.localeCompare(a.date));

  return {
    shareId: share.id,
    accountName: share.accountName,
    accountType: share.accountType,
    ownerName,
    visibility,
    month,
    items,
    mineTotal: { ARS: round2(mineTotal.ARS), USD: round2(mineTotal.USD) },
    accountTotal: visibility === "all" ? { ARS: round2(accountTotal.ARS), USD: round2(accountTotal.USD) } : null,
    dueDate: dueDate ? (dueDate as Date).toISOString() : null,
  };
};

/** El dueño cambia qué ve el invitado. */
export const setShareVisibility = async (ownerUid: string, shareId: string, visibility: ShareVisibility) => {
  const ref = adminDb().collection("accountShares").doc(shareId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.ownerUid !== ownerUid) throw new ShareAccessError("No autorizado");
  await ref.update({ visibility, updatedAt: new Date() });
};
