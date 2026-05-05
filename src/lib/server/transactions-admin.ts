import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

const lastDayOfMonth = (year: number, month: number) =>
  new Date(year, month, 0).getDate();

const clampDay = (year: number, month: number, day: number) =>
  Math.min(day, lastDayOfMonth(year, month));

const monthKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;

const addMonths = (year: number, month: number, n: number) => {
  const total = month - 1 + n;
  const newYear = year + Math.floor(total / 12);
  const newMonth = ((total % 12) + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
};

export interface ServerAccount {
  id: string;
  type: "cash" | "debit" | "credit" | "checking" | "savings" | "digital";
  defaultClosingDay?: number;
  defaultDueDay?: number;
}

interface CycleData {
  closingDate: Timestamp;
  dueDate: Timestamp;
}

const buildDefaultCycle = (
  account: ServerAccount,
  year: number,
  month: number,
): CycleData => {
  const closingDay = clampDay(year, month, account.defaultClosingDay ?? 1);
  const closingDate = new Date(year, month - 1, closingDay, 23, 59, 59);

  const dueDay = account.defaultDueDay ?? closingDay;
  let dueYear = year;
  let dueMonth = month;
  if (dueDay <= closingDay) {
    dueMonth = month + 1;
    if (dueMonth > 12) {
      dueMonth = 1;
      dueYear += 1;
    }
  }
  const dueDate = new Date(
    dueYear,
    dueMonth - 1,
    clampDay(dueYear, dueMonth, dueDay),
    12,
    0,
    0,
  );
  return {
    closingDate: Timestamp.fromDate(closingDate),
    dueDate: Timestamp.fromDate(dueDate),
  };
};

const getOrBuildCycle = async (
  uid: string,
  account: ServerAccount,
  year: number,
  month: number,
): Promise<CycleData> => {
  const key = monthKey(year, month);
  const ref = adminDb()
    .collection(`users/${uid}/accounts/${account.id}/cycles`)
    .doc(key);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() as { closingDate: Timestamp; dueDate: Timestamp };
    return { closingDate: data.closingDate, dueDate: data.dueDate };
  }
  return buildDefaultCycle(account, year, month);
};

const computeFirstBillingMonth = (
  account: ServerAccount,
  purchaseDate: Date,
  cardClosedAtPurchase: boolean,
) => {
  const year = purchaseDate.getFullYear();
  const month = purchaseDate.getMonth() + 1;
  const closingDay = clampDay(year, month, account.defaultClosingDay ?? 1);
  const purchaseDay = purchaseDate.getDate();
  const movesToNext = cardClosedAtPurchase || purchaseDay > closingDay;
  if (!movesToNext) return { year, month };
  return addMonths(year, month, 1);
};

export interface ServerCreateInput {
  ownerUid: string;
  account: ServerAccount;
  accountId: string;
  categoryId: string;
  description: string;
  totalAmount: number;
  purchaseDate: Date;
  kind: "expense";
  installments: number;
  cardClosedAtPurchase?: boolean;
}

export const createTransactionAdmin = async (
  input: ServerCreateInput,
): Promise<string> => {
  const isCredit = input.account.type === "credit";
  const installmentsCount = isCredit ? Math.max(1, input.installments) : 1;
  const amountPerInstallment =
    Math.round((input.totalAmount / installmentsCount) * 100) / 100;

  const txCol = adminDb().collection(`users/${input.ownerUid}/transactions`);
  const insCol = adminDb().collection(`users/${input.ownerUid}/installments`);

  const txRef = txCol.doc();

  let firstYear: number;
  let firstMonth: number;
  if (isCredit) {
    const first = computeFirstBillingMonth(
      input.account,
      input.purchaseDate,
      input.cardClosedAtPurchase ?? false,
    );
    firstYear = first.year;
    firstMonth = first.month;
  } else {
    firstYear = input.purchaseDate.getFullYear();
    firstMonth = input.purchaseDate.getMonth() + 1;
  }

  const batch = adminDb().batch();

  batch.set(txRef, {
    accountId: input.accountId,
    categoryId: input.categoryId,
    description: input.description,
    totalAmount: input.totalAmount,
    purchaseDate: Timestamp.fromDate(input.purchaseDate),
    kind: "expense",
    installments: installmentsCount,
    cardClosedAtPurchase: isCredit ? input.cardClosedAtPurchase ?? false : false,
    firstBillingMonth: monthKey(firstYear, firstMonth),
    createdAt: FieldValue.serverTimestamp(),
  });

  for (let i = 0; i < installmentsCount; i += 1) {
    const { year, month } = addMonths(firstYear, firstMonth, i);
    let billingDate: Date;
    if (isCredit) {
      const cycle = await getOrBuildCycle(
        input.ownerUid,
        input.account,
        year,
        month,
      );
      billingDate = cycle.dueDate.toDate();
    } else {
      billingDate = input.purchaseDate;
    }
    const insRef = insCol.doc();
    batch.set(insRef, {
      transactionId: txRef.id,
      accountId: input.accountId,
      categoryId: input.categoryId,
      amount: amountPerInstallment,
      billingMonth: monthKey(year, month),
      billingDate: Timestamp.fromDate(billingDate),
      installmentNumber: i + 1,
      totalInstallments: installmentsCount,
      kind: "expense",
      description: input.description,
    });
  }

  await batch.commit();
  return txRef.id;
};
