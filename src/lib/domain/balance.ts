import type { Installment, SharedExpense } from "./types";
import { getEffectiveInstallmentInfo } from "./shared-effective";

export interface MonthlyBalance {
  income: number;
  expense: number;
  balance: number;
}

export interface SharedAdjustment {
  sharedByTxId: Map<string, SharedExpense>;
  ownerUid: string;
}

const expenseAmount = (
  ins: Installment,
  adj: SharedAdjustment | undefined,
): number => {
  if (!adj) return ins.amount;
  return getEffectiveInstallmentInfo(ins, adj.sharedByTxId, adj.ownerUid)
    .effectiveAmount;
};

export const computeMonthlyBalance = (
  installments: Installment[],
  monthKey: string,
  adj?: SharedAdjustment,
): MonthlyBalance => {
  let income = 0;
  let expense = 0;
  for (const ins of installments) {
    if (ins.billingMonth !== monthKey) continue;
    if (ins.kind === "income") income += ins.amount;
    else if (ins.kind === "expense") expense += expenseAmount(ins, adj);
    // transferencias no afectan el balance global
  }
  return { income, expense, balance: income - expense };
};

export const sumByCategory = (
  installments: Installment[],
  monthKey: string,
  adj?: SharedAdjustment,
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const ins of installments) {
    if (ins.billingMonth !== monthKey) continue;
    if (ins.kind !== "expense") continue;
    const a = expenseAmount(ins, adj);
    map.set(ins.categoryId, (map.get(ins.categoryId) ?? 0) + a);
  }
  return map;
};

export const sumByAccount = (
  installments: Installment[],
  monthKey: string,
  adj?: SharedAdjustment,
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const ins of installments) {
    if (ins.billingMonth !== monthKey) continue;
    if (ins.kind !== "expense") continue;
    const a = expenseAmount(ins, adj);
    map.set(ins.accountId, (map.get(ins.accountId) ?? 0) + a);
  }
  return map;
};
