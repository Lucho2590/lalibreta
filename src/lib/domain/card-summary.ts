import type { Currency, Installment } from "./types";
import { currencyOf, isCardCredit, monthOf } from "./types";

/**
 * Resumen de una tarjeta para un MES DE PAGO (el mes en que vence el
 * resumen). Es el mismo número que el "Total a pagar" del banco:
 * gastos − reintegros. Se usa en Movimientos, el detalle de la tarjeta, la
 * lista de cuentas y el inicio, para que todas las pantallas coincidan.
 */

export type Money = Record<Currency, number>;
const zero = (): Money => ({ ARS: 0, USD: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;
const roundAll = (m: Money): Money => ({ ARS: round2(m.ARS), USD: round2(m.USD) });

export interface CardMonthSummary {
  /** Consumos, cuotas, impuestos y cargos (monto completo, como lo cobra el banco). */
  expenses: Money;
  /** Reintegros, devoluciones y bonificaciones (saldo a favor). */
  credits: Money;
  /** Parte de los gastos que son impuestos y comisiones. */
  taxes: Money;
  /** Parte de los gastos que son estimados (suscripciones proyectadas). */
  projected: Money;
  /** Total a pagar del resumen: gastos − reintegros. */
  total: Money;
  /** Pagos de la tarjeta registrados en ese mes. */
  paid: Money;
  /** Lo que falta pagar de ese resumen (nunca negativo). */
  pending: Money;
  /** Vencimiento del resumen (si hay gastos). */
  dueDate: Date | null;
  /** Cantidad de movimientos (sin pagos). */
  count: number;
}

type Ins = Pick<
  Installment,
  "accountId" | "amount" | "kind" | "billingMonth" | "paymentMonth" | "currency" | "categoryId" | "projected" | "cardCredit" | "transferRole"
> & { billingDate?: { toDate(): Date } };

export const summarizeCardMonth = (
  installments: Ins[],
  cardIds: Set<string> | string[],
  monthKey: string,
  taxCategoryIds: Set<string> = new Set(),
): CardMonthSummary => {
  const ids = cardIds instanceof Set ? cardIds : new Set(cardIds);
  const s = {
    expenses: zero(),
    credits: zero(),
    taxes: zero(),
    projected: zero(),
    paid: zero(),
  };
  let dueDate: Date | null = null;
  let count = 0;
  for (const i of installments) {
    if (!ids.has(i.accountId) || monthOf(i) !== monthKey) continue;
    const c = currencyOf(i);
    if (i.kind === "expense") {
      s.expenses[c] += i.amount;
      if (taxCategoryIds.has(i.categoryId)) s.taxes[c] += i.amount;
      if (i.projected) s.projected[c] += i.amount;
      if (!dueDate && i.billingDate) dueDate = i.billingDate.toDate();
      count += 1;
    } else if (isCardCredit(i)) {
      s.credits[c] += i.amount;
      count += 1;
    } else if (i.kind === "transfer" && i.transferRole === "destination") {
      // Pago de la tarjeta (entra plata a la tarjeta).
      s.paid[c] += i.amount;
    }
  }
  const total: Money = { ARS: s.expenses.ARS - s.credits.ARS, USD: s.expenses.USD - s.credits.USD };
  const pending: Money = {
    ARS: Math.max(0, total.ARS - s.paid.ARS),
    USD: Math.max(0, total.USD - s.paid.USD),
  };
  return {
    expenses: roundAll(s.expenses),
    credits: roundAll(s.credits),
    taxes: roundAll(s.taxes),
    projected: roundAll(s.projected),
    total: roundAll(total),
    paid: roundAll(s.paid),
    pending: roundAll(pending),
    dueDate,
    count,
  };
};

/** Categorías que cuentan como "impuestos y comisiones". */
export const TAX_CATEGORY = /impuest|comisi|banc|cargo/i;

export const nextMonthKey = (key: string): string => {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
