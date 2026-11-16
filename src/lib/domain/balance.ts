import type { Currency, Installment } from "./types";
import { currencyOf, monthOf } from "./types";
import type { SplitTxInfo } from "./debts";

export interface MonthlyBalance {
  income: number;
  expense: number;
  balance: number;
}

/**
 * Gastos repartidos con otras personas: por id de transacción, qué parte del
 * gasto es mía (ver buildSplitAdjustment en debts.ts). Sin ajuste, todo es mío.
 */
export interface SharedAdjustment {
  byTxId: Map<string, SplitTxInfo>;
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
  const info = adj?.byTxId.get(ins.transactionId);
  return info ? Math.round(ins.amount * info.factor * 100) / 100 : ins.amount;
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

export interface AccountFlow {
  /** Ingresos de verdad (sueldo, cobros…). */
  income: number;
  /** Gastos: lo que salió de verdad (un gasto repartido sale entero de la cuenta). */
  expense: number;
  /** Plata que entró desde otra cuenta (propia o de una persona). */
  transfersIn: number;
  /** Plata que salió a otra cuenta (propia o de una persona, pagos de tarjeta). */
  transfersOut: number;
  /** Todo lo que entró / salió y la diferencia. */
  in: number;
  out: number;
  net: number;
}

/**
 * Entradas y salidas del mes de UNA cuenta (o un grupo: la cuenta con sus
 * cobachas/tarjetas) en una moneda. A diferencia de computeMonthlyBalance,
 * acá las transferencias SÍ cuentan: mirando una cuenta, lo que te pasaste
 * desde otra entró. Los movimientos dentro del grupo en la misma moneda
 * (ej. guardar en una cobacha de la misma cuenta) no cuentan.
 */
export const computeAccountFlow = (
  installments: Installment[],
  monthKey: string,
  accountIds: ReadonlySet<string>,
  currency: Currency = "ARS",
): AccountFlow => {
  const legsByTx = new Map<string, Installment[]>();
  for (const ins of installments) {
    if (ins.kind !== "transfer") continue;
    legsByTx.set(ins.transactionId, [...(legsByTx.get(ins.transactionId) ?? []), ins]);
  }
  let income = 0;
  let expense = 0;
  let transfersIn = 0;
  let transfersOut = 0;
  for (const ins of installments) {
    if (!accountIds.has(ins.accountId)) continue;
    if (monthOf(ins) !== monthKey) continue;
    if (currencyOf(ins) !== currency) continue;
    if (ins.kind === "income") {
      if (ins.cardCredit) expense -= ins.amount;
      else income += ins.amount;
    } else if (ins.kind === "expense") {
      expense += ins.amount;
    } else if (ins.kind === "transfer") {
      const other = legsByTx.get(ins.transactionId)?.find((l) => l.id !== ins.id);
      const counterpartId = other?.accountId ?? ins.transferCounterpartId;
      const internal =
        !!counterpartId &&
        accountIds.has(counterpartId) &&
        (!other || currencyOf(other) === currency);
      if (internal) continue;
      if (ins.transferRole === "destination") transfersIn += ins.amount;
      else transfersOut += ins.amount;
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  const inTotal = income + transfersIn;
  const outTotal = expense + transfersOut;
  return {
    income: r(income),
    expense: r(expense),
    transfersIn: r(transfersIn),
    transfersOut: r(transfersOut),
    in: r(inTotal),
    out: r(outTotal),
    net: r(inTotal - outTotal),
  };
};
