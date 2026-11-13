import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { createAccountAdmin, setAccountLast4, setCardDatesAdmin } from "./accounts-admin";
import { createTransactionAdmin } from "./transactions-admin";
import { loadAccounts, toServerAccount } from "./queries-admin";
import { dateFromYMD } from "./time";
import type { StatementDraft } from "./whatsapp/types";
import { paymentMonthOf } from "@/lib/domain/types";

/**
 * Guardado y lectura de resúmenes de tarjeta.
 *
 * Al guardar un resumen:
 * - crea la tarjeta si no existía (newCard)
 * - guarda los ciclos reales (cierre/vencimiento) de ese mes y del próximo
 * - actualiza la fecha de pago de las cuotas ya cargadas de esos meses
 * - guarda los últimos 4 dígitos
 * - guarda el detalle en users/{uid}/cardStatements/{accountId}_{YYYY-MM}
 * - modo "all": carga los impuestos/cargos como un gasto y da de alta las
 *   suscripciones como gastos fijos
 */

const CHARGE_TYPES = new Set(["tax", "fee", "interest"]);

const closingTimestamp = (ymd: string) =>
  Timestamp.fromDate(new Date(`${ymd}T23:59:59-03:00`));
const dueTimestamp = (ymd: string) => Timestamp.fromDate(dateFromYMD(ymd));

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const MONTHS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];
const periodLabel = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[m - 1]}/${String(y).slice(2)}`;
};

export interface SaveStatementResult {
  accountId: string;
  accountName: string;
  createdAccount: boolean;
  /** La tarjeta tenía las fechas pendientes y se completaron con el resumen. */
  datesCompleted: boolean;
  /** Gastos reacomodados al completar las fechas. */
  purchasesReorganized: number;
  cyclesSaved: string[];
  installmentsUpdated: number;
  chargesTransaction: "created" | "already-existed" | "none" | "skipped";
  subscriptionsCreated: string[];
  subscriptionsSkipped: string[];
}

const saveCycleAndUpdateInstallments = async (
  uid: string,
  accountId: string,
  closingYMD: string,
  dueYMD: string,
): Promise<{ key: string; updated: number }> => {
  const db = adminDb();
  const key = closingYMD.slice(0, 7);
  const [year, month] = key.split("-").map(Number);
  const dueDate = dueTimestamp(dueYMD);
  await db.doc(`users/${uid}/accounts/${accountId}/cycles/${key}`).set({
    year,
    month,
    closingDate: closingTimestamp(closingYMD),
    dueDate,
  });

  // Las cuotas de tarjeta usan la fecha de vencimiento del ciclo como billingDate.
  const snap = await db
    .collection(`users/${uid}/installments`)
    .where("accountId", "==", accountId)
    .where("billingMonth", "==", key)
    .get();
  let updated = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + 400)) {
      batch.update(d.ref, { billingDate: dueDate, paymentMonth: paymentMonthOf(dueDate.toDate()) });
      updated += 1;
    }
    await batch.commit();
  }
  return { key, updated };
};

export const saveStatementAdmin = async (
  uid: string,
  draft: StatementDraft,
  mode: "all" | "summary",
): Promise<SaveStatementResult> => {
  const db = adminDb();

  // 1. Tarjeta: existente o nueva.
  let accountId = draft.accountId;
  let createdAccount = false;
  if (!accountId) {
    if (!draft.newCard) throw new Error("El resumen no tiene tarjeta");
    accountId = await createAccountAdmin(uid, {
      name: draft.newCard.name,
      type: "credit",
      closingDay: Number(draft.closingDate.slice(8, 10)),
      dueDay: Number(draft.dueDate.slice(8, 10)),
      parentId: draft.newCard.parentId,
      last4: draft.last4,
    });
    createdAccount = true;
  }
  const accounts = await loadAccounts(uid);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error("La tarjeta ya no existe");

  // 2. Ciclos reales del resumen (y del próximo, si lo trae).
  const cyclesSaved: string[] = [];
  let installmentsUpdated = 0;
  const current = await saveCycleAndUpdateInstallments(
    uid,
    accountId,
    draft.closingDate,
    draft.dueDate,
  );
  cyclesSaved.push(current.key);
  installmentsUpdated += current.updated;
  if (draft.nextClosingDate && draft.nextDueDate) {
    const next = await saveCycleAndUpdateInstallments(
      uid,
      accountId,
      draft.nextClosingDate,
      draft.nextDueDate,
    );
    if (next.key !== current.key) {
      cyclesSaved.push(next.key);
      installmentsUpdated += next.updated;
    }
  }

  // 2b. Tarjeta con fechas pendientes: las completamos con las del resumen y
  // reacomodamos lo cargado mientras tanto.
  let datesCompleted = false;
  let purchasesReorganized = 0;
  if (!account.defaultClosingDay || !account.defaultDueDay) {
    const r = await setCardDatesAdmin(
      uid,
      toServerAccount(account),
      Number(draft.closingDate.slice(8, 10)),
      Number(draft.dueDate.slice(8, 10)),
    );
    datesCompleted = true;
    purchasesReorganized = r.rebuilt;
  }

  // 3. Últimos 4 dígitos.
  if (draft.last4 && !createdAccount) await setAccountLast4(uid, accountId, draft.last4);

  // 4. Resumen (reemplaza al del mismo mes si se manda dos veces).
  const statementRef = db.doc(`users/${uid}/cardStatements/${accountId}_${draft.period}`);
  const existing = await statementRef.get();
  let chargesTransactionId =
    (existing.data()?.chargesTransactionId as string | null | undefined) ?? null;
  let chargesTransactionIdUSD =
    (existing.data()?.chargesTransactionIdUSD as string | null | undefined) ?? null;

  // 5. Impuestos y cargos como gasto, uno por moneda (una sola vez por resumen).
  let chargesTransaction: SaveStatementResult["chargesTransaction"] = "none";
  const chargesBase = {
    ownerUid: uid,
    account: toServerAccount(account),
    accountId,
    description: `Impuestos y cargos ${account.name} ${periodLabel(draft.period)}`,
    purchaseDate: dateFromYMD(draft.closingDate),
    kind: "expense" as const,
    installments: 1,
    forceFirstBillingMonth: draft.period,
  };
  if (mode === "summary") {
    chargesTransaction = "skipped";
  } else if (chargesTransactionId || chargesTransactionIdUSD) {
    chargesTransaction = "already-existed";
  } else if (draft.chargesCategoryId && (draft.chargesARS > 0 || (draft.chargesUSD ?? 0) > 0)) {
    if (draft.chargesARS > 0) {
      chargesTransactionId = await createTransactionAdmin({
        ...chargesBase,
        categoryId: draft.chargesCategoryId,
        totalAmount: draft.chargesARS,
        currency: "ARS",
      });
    }
    if ((draft.chargesUSD ?? 0) > 0) {
      chargesTransactionIdUSD = await createTransactionAdmin({
        ...chargesBase,
        categoryId: draft.chargesCategoryId,
        totalAmount: draft.chargesUSD!,
        currency: "USD",
      });
    }
    chargesTransaction = "created";
  }

  await statementRef.set({
    accountId,
    accountName: account.name,
    period: draft.period,
    closingDate: closingTimestamp(draft.closingDate),
    dueDate: dueTimestamp(draft.dueDate),
    nextClosingDate: draft.nextClosingDate ? closingTimestamp(draft.nextClosingDate) : null,
    nextDueDate: draft.nextDueDate ? dueTimestamp(draft.nextDueDate) : null,
    last4: draft.last4,
    totalARS: draft.totalARS,
    totalUSD: draft.totalUSD,
    minimumPayment: draft.minimumPayment,
    chargesARS: draft.chargesARS,
    chargesUSD: draft.chargesUSD ?? 0,
    lines: draft.lines,
    chargesTransactionId,
    chargesTransactionIdUSD,
    createdAt: Timestamp.now(),
  });

  // 6. Suscripciones como fijos (sin duplicar las que ya existen).
  const subscriptionsCreated: string[] = [];
  const subscriptionsSkipped: string[] = [];
  if (mode === "all" && draft.subscriptions.length > 0) {
    const recurringCol = db.collection(`users/${uid}/recurring`);
    const existingRecurring = await recurringCol.get();
    const existingNames = new Set(
      existingRecurring.docs
        .filter((d) => d.data().accountId === accountId)
        .map((d) => normalize(String(d.data().name ?? ""))),
    );
    for (const sub of draft.subscriptions) {
      const key = normalize(sub.name);
      if (existingNames.has(key)) {
        subscriptionsSkipped.push(sub.name);
        continue;
      }
      await recurringCol.add({
        name: sub.name,
        amount: sub.amount,
        currency: sub.currency ?? "ARS",
        accountId,
        categoryId: sub.categoryId,
        kind: "expense",
        dayOfMonth: Math.min(31, Math.max(1, sub.dayOfMonth)),
        startMonth: draft.period,
        endMonth: null,
        active: true,
        createdAt: Timestamp.now(),
      });
      existingNames.add(key);
      subscriptionsCreated.push(sub.name);
    }
  }

  return {
    accountId,
    accountName: account.name,
    createdAccount,
    datesCompleted,
    purchasesReorganized,
    cyclesSaved,
    installmentsUpdated,
    chargesTransaction,
    subscriptionsCreated,
    subscriptionsSkipped,
  };
};

// === Lectura para el análisis del agente ===

const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (t: Timestamp | null | undefined) =>
  t ? t.toDate().toISOString().slice(0, 10) : null;

interface StoredLine {
  description: string;
  amount: number;
  currency: "ARS" | "USD";
  type: string;
  installment: string | null;
}

export interface StatementHistoryItem {
  account: string;
  period: string;
  closingDate: string | null;
  dueDate: string | null;
  totalARS: number;
  totalUSD: number;
  /** Compras, cuotas y suscripciones en ARS (lo "consumido"). */
  consumptionARS: number;
  chargesARS: number;
  /** chargesARS / consumptionARS, en %. */
  chargesPct: number | null;
  charges: Array<{ description: string; amount: number; type: string }>;
  subscriptions: Array<{ description: string; amount: number; currency: string }>;
}

export const getStatementHistory = async (
  uid: string,
  opts: { accountId?: string; limit?: number } = {},
): Promise<StatementHistoryItem[]> => {
  // Pocos docs por usuario: filtramos y ordenamos en memoria para no
  // depender de índices compuestos.
  const snap = await adminDb().collection(`users/${uid}/cardStatements`).get();
  return snap.docs
    .map((d) => d.data())
    .filter((s) => !opts.accountId || s.accountId === opts.accountId)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))
    .slice(0, opts.limit ?? 12)
    .map((s) => {
      const lines = (s.lines ?? []) as StoredLine[];
      const ars = lines.filter((l) => l.currency === "ARS");
      const consumption = ars
        .filter((l) => ["purchase", "installment", "subscription"].includes(l.type))
        .reduce((acc, l) => acc + l.amount, 0);
      const charges = ars.filter((l) => CHARGE_TYPES.has(l.type));
      const chargesARS = Number(s.chargesARS ?? 0);
      return {
        account: String(s.accountName ?? ""),
        period: String(s.period),
        closingDate: ymd(s.closingDate as Timestamp),
        dueDate: ymd(s.dueDate as Timestamp),
        totalARS: Number(s.totalARS ?? 0),
        totalUSD: Number(s.totalUSD ?? 0),
        consumptionARS: round2(consumption),
        chargesARS,
        chargesPct: consumption > 0 ? round2((chargesARS / consumption) * 100) : null,
        charges: charges.map((l) => ({
          description: l.description,
          amount: l.amount,
          type: l.type,
        })),
        subscriptions: lines
          .filter((l) => l.type === "subscription")
          .map((l) => ({ description: l.description, amount: l.amount, currency: l.currency })),
      };
    });
};

export { CHARGE_TYPES };

/** Último resumen guardado de una tarjeta (para sugerir el monto a pagar). */
export const getLatestStatement = async (
  uid: string,
  accountId: string,
): Promise<{ period: string; totalARS: number; totalUSD: number; dueDate: string | null } | null> => {
  const snap = await adminDb().collection(`users/${uid}/cardStatements`).get();
  const latest = snap.docs
    .map((d) => d.data())
    .filter((s) => s.accountId === accountId)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
  if (!latest) return null;
  return {
    period: String(latest.period),
    totalARS: Number(latest.totalARS ?? 0),
    totalUSD: Number(latest.totalUSD ?? 0),
    dueDate: ymd(latest.dueDate as Timestamp),
  };
};
