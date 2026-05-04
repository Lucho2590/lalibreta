import type { Installment } from "./types";

export interface MonthlyBalance {
  income: number;
  expense: number;
  balance: number;
}

export const computeMonthlyBalance = (
  installments: Installment[],
  monthKey: string,
): MonthlyBalance => {
  let income = 0;
  let expense = 0;
  for (const ins of installments) {
    if (ins.billingMonth !== monthKey) continue;
    if (ins.kind === "income") income += ins.amount;
    else if (ins.kind === "expense") expense += ins.amount;
    // transferencias no afectan el balance global
  }
  return { income, expense, balance: income - expense };
};

export const sumByCategory = (
  installments: Installment[],
  monthKey: string,
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const ins of installments) {
    if (ins.billingMonth !== monthKey) continue;
    if (ins.kind !== "expense") continue;
    map.set(ins.categoryId, (map.get(ins.categoryId) ?? 0) + ins.amount);
  }
  return map;
};

export const sumByAccount = (
  installments: Installment[],
  monthKey: string,
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const ins of installments) {
    if (ins.billingMonth !== monthKey) continue;
    if (ins.kind !== "expense") continue;
    map.set(ins.accountId, (map.get(ins.accountId) ?? 0) + ins.amount);
  }
  return map;
};
