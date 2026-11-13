import type { Currency, Installment, SharedExpense } from "./types";
import { currencyOf, monthOf } from "./types";
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

/**
 * Pasa un monto a pesos. Si no hay cotización, los dólares no se pueden
 * convertir y se ignoran en los totales "en pesos".
 */
export type ToARS = (amount: number, currency: Currency) => number | null;

export const makeToARS = (usdRate: number | null | undefined): ToARS =>
  (amount, currency) =>
    currency === "ARS" ? amount : usdRate ? amount * usdRate : null;

const expenseAmount = (
  ins: Installment,
  adj: SharedAdjustment | undefined,
): number => {
  if (!adj) return ins.amount;
  return getEffectiveInstallmentInfo(ins, adj.sharedByTxId, adj.ownerUid)
    .effectiveAmount;
};

/** Ingresos y gastos del mes en UNA moneda (las transferencias no cuentan). */
export const computeMonthlyBalance = (
  installments: Installment[],
  monthKey: string,
  adj?: SharedAdjustment,
  currency: Currency = "ARS",
): MonthlyBalance => {
  let income = 0;
  let expense = 0;
  for (const ins of installments) {
    if (monthOf(ins) !== monthKey) continue;
    if (currencyOf(ins) !== currency) continue;
    if (ins.kind === "income") {
      // Reintegro en tarjeta: baja el gasto, no es un ingreso.
      if (ins.cardCredit) expense -= ins.amount;
      else income += ins.amount;
    } else if (ins.kind === "expense") expense += expenseAmount(ins, adj);
    // transferencias (incluidos cambios de moneda y pagos de tarjeta) no afectan el balance
  }
  return { income, expense, balance: income - expense };
};

const sumBy = (
  installments: Installment[],
  monthKey: string,
  key: (ins: Installment) => string,
  adj?: SharedAdjustment,
  toARS?: ToARS,
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const ins of installments) {
    if (monthOf(ins) !== monthKey) continue;
    // Gastos suman; un reintegro de tarjeta resta (en la misma clave).
    const credit = ins.kind === "income" && !!ins.cardCredit;
    if (ins.kind !== "expense" && !credit) continue;
    const raw = credit ? -ins.amount : expenseAmount(ins, adj);
    // Sin conversor: solo pesos. Con conversor: todo en pesos equivalentes.
    const a = toARS ? toARS(raw, currencyOf(ins)) : currencyOf(ins) === "ARS" ? raw : null;
    if (a == null) continue;
    map.set(key(ins), (map.get(key(ins)) ?? 0) + a);
  }
  return map;
};

/** Gastos del mes por categoría, en pesos (los USD se convierten si hay toARS). */
export const sumByCategory = (
  installments: Installment[],
  monthKey: string,
  adj?: SharedAdjustment,
  toARS?: ToARS,
): Map<string, number> => sumBy(installments, monthKey, (i) => i.categoryId, adj, toARS);

/** Gastos del mes por cuenta, en pesos (los USD se convierten si hay toARS). */
export const sumByAccount = (
  installments: Installment[],
  monthKey: string,
  adj?: SharedAdjustment,
  toARS?: ToARS,
): Map<string, number> => sumBy(installments, monthKey, (i) => i.accountId, adj, toARS);
