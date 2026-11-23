import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Account, CardCycle, RecurringExpense } from "./types";
import { monthKey, paymentMonthOf } from "./types";
import { apiPost } from "@/lib/api";
import {
  createTransactionWithInstallments,
  installmentsCollectionPath,
} from "./installments";
import { addMonths, computeFirstBillingMonth, getOrBuildCycle } from "./cycles";

export const recurringCollectionPath = (uid: string): string =>
  `users/${uid}/recurring`;

const lastDayOfMonth = (year: number, month: number) =>
  new Date(year, month, 0).getDate();

const buildBillingDate = (year: number, month: number, day: number): Date => {
  const safeDay = Math.min(day, lastDayOfMonth(year, month));
  return new Date(year, month - 1, safeDay, 12, 0, 0);
};

export const isInRange = (
  rec: RecurringExpense,
  year: number,
  month: number,
): boolean => {
  const target = monthKey(year, month);
  if (target < rec.startMonth) return false;
  if (rec.endMonth && target > rec.endMonth) return false;
  return true;
};

/**
 * El mes de un fijo es el mes en que se PAGA, como en el resto de la app: un
 * fijo con tarjeta "de diciembre" es el que viene en el resumen que vence en
 * diciembre (comprado en noviembre).
 */
export const isAppliedToMonth = async (
  uid: string,
  recurringId: string,
  year: number,
  month: number,
): Promise<boolean> => {
  const target = monthKey(year, month);
  const snap = await getDocs(
    query(
      collection(db, installmentsCollectionPath(uid)),
      where("recurringId", "==", recurringId),
      where("paymentMonth", "==", target),
    ),
  );
  return !snap.empty;
};

/**
 * Fecha de compra para que un fijo con tarjeta caiga en el resumen que se
 * paga en year/month: el día del fijo en el mes del cierre de ese resumen (o
 * en el anterior, si el día es después del cierre). Si la tarjeta no tiene
 * ese resumen cerca, el día del fijo en ese mes (como antes).
 */
export const cardPurchaseDateFor = async (
  uid: string,
  account: Account,
  day: number,
  year: number,
  month: number,
  /** Para probarlo sin Firestore. */
  cycleFor: (year: number, month: number) => Promise<CardCycle> = (y, m) => getOrBuildCycle(uid, account, y, m),
): Promise<Date> => {
  const target = monthKey(year, month);
  for (const back of [1, 0, 2]) {
    const b = addMonths(year, month, -back);
    const cycle = await cycleFor(b.year, b.month);
    if (paymentMonthOf(cycle.dueDate.toDate()) !== target) continue;
    const prev = addMonths(b.year, b.month, -1);
    const closingDay = cycle.closingDate.toDate().getDate();
    const options = [
      buildBillingDate(b.year, b.month, day),
      buildBillingDate(prev.year, prev.month, day),
      buildBillingDate(b.year, b.month, closingDay),
    ];
    const fits = options.find((d) => {
      const f = computeFirstBillingMonth(account, d, false);
      return f.year === b.year && f.month === b.month;
    });
    if (fits) return fits;
  }
  return buildBillingDate(year, month, day);
};

export const applyRecurringToMonth = async (
  uid: string,
  recurring: RecurringExpense,
  year: number,
  month: number,
  account: Account,
): Promise<"created" | "skipped"> => {
  if (!recurring.active) return "skipped";
  if (!isInRange(recurring, year, month)) return "skipped";
  if (await isAppliedToMonth(uid, recurring.id, year, month)) return "skipped";

  const purchaseDate =
    account.type === "credit"
      ? await cardPurchaseDateFor(uid, account, recurring.dayOfMonth, year, month)
      : buildBillingDate(year, month, recurring.dayOfMonth);

  const txId = await createTransactionWithInstallments(uid, account, {
    accountId: recurring.accountId,
    categoryId: recurring.categoryId,
    description: recurring.name,
    totalAmount: recurring.amount,
    purchaseDate,
    kind: recurring.kind,
    installments: 1,
    cardClosedAtPurchase: false,
    recurringId: recurring.id,
    currency: recurring.currency ?? "ARS",
  });
  // Si es algo que se divide siempre (ej. el alquiler con Orne), se divide solo.
  if (recurring.kind === "expense") {
    await apiPost("/api/splits/auto", { txIds: [txId] }).catch((err) => console.warn("[splits/auto]", err));
  }
  return "created";
};

export const applyAllRecurringToMonth = async (
  uid: string,
  recurrings: RecurringExpense[],
  accounts: Account[],
  year: number,
  month: number,
): Promise<{ applied: number; skipped: number }> => {
  let applied = 0;
  let skipped = 0;
  for (const rec of recurrings) {
    const account = accounts.find((a) => a.id === rec.accountId);
    if (!account) {
      skipped += 1;
      continue;
    }
    const result = await applyRecurringToMonth(uid, rec, year, month, account);
    if (result === "created") applied += 1;
    else skipped += 1;
  }
  return { applied, skipped };
};
