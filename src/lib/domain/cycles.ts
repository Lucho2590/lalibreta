import {
  Timestamp,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Account, CardCycle } from "./types";
import { monthKey } from "./types";

const lastDayOfMonth = (year: number, month: number): number =>
  new Date(year, month, 0).getDate();

const clampDay = (year: number, month: number, day: number): number =>
  Math.min(day, lastDayOfMonth(year, month));

export const cycleDocPath = (uid: string, accountId: string, key: string): string =>
  `users/${uid}/accounts/${accountId}/cycles/${key}`;

export const buildDefaultCycle = (
  account: Account,
  year: number,
  month: number,
): Omit<CardCycle, "id"> => {
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
  const dueDate = new Date(dueYear, dueMonth - 1, clampDay(dueYear, dueMonth, dueDay), 12, 0, 0);

  return {
    year,
    month,
    closingDate: Timestamp.fromDate(closingDate),
    dueDate: Timestamp.fromDate(dueDate),
  };
};

export const getOrBuildCycle = async (
  uid: string,
  account: Account,
  year: number,
  month: number,
): Promise<CardCycle> => {
  const key = monthKey(year, month);
  const ref = doc(db, cycleDocPath(uid, account.id, key));
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { id: key, ...(snap.data() as Omit<CardCycle, "id">) };
  }
  return { id: key, ...buildDefaultCycle(account, year, month) };
};

export const saveCycle = async (
  uid: string,
  accountId: string,
  cycle: Omit<CardCycle, "id">,
): Promise<string> => {
  const key = monthKey(cycle.year, cycle.month);
  const ref = doc(db, cycleDocPath(uid, accountId, key));
  await setDoc(ref, cycle);
  return key;
};

export const computeFirstBillingMonth = (
  account: Account,
  purchaseDate: Date,
  cardClosedAtPurchase: boolean,
): { year: number; month: number } => {
  const year = purchaseDate.getFullYear();
  const month = purchaseDate.getMonth() + 1;
  const closingDay = clampDay(year, month, account.defaultClosingDay ?? 1);
  const purchaseDay = purchaseDate.getDate();

  const movesToNext = cardClosedAtPurchase || purchaseDay > closingDay;
  if (!movesToNext) return { year, month };
  const nextMonth = month + 1;
  if (nextMonth > 12) return { year: year + 1, month: 1 };
  return { year, month: nextMonth };
};

export const addMonths = (year: number, month: number, n: number): { year: number; month: number } => {
  const total = month - 1 + n;
  const newYear = year + Math.floor(total / 12);
  const newMonth = ((total % 12) + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
};
