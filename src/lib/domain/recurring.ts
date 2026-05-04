import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Account, RecurringExpense } from "./types";
import { monthKey } from "./types";
import {
  createTransactionWithInstallments,
  installmentsCollectionPath,
} from "./installments";

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
      where("billingMonth", "==", target),
    ),
  );
  return !snap.empty;
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

  const purchaseDate = buildBillingDate(year, month, recurring.dayOfMonth);

  await createTransactionWithInstallments(uid, account, {
    accountId: recurring.accountId,
    categoryId: recurring.categoryId,
    description: recurring.name,
    totalAmount: recurring.amount,
    purchaseDate,
    kind: recurring.kind,
    installments: 1,
    cardClosedAtPurchase: false,
    recurringId: recurring.id,
  });
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
