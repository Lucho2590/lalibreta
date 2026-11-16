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
  /**
   * Pagos aplicados a este resumen. Los pagos cubren primero el resumen más
   * viejo con deuda y el resto pasa al siguiente: pagar en noviembre el
   * resumen que vence en diciembre cuenta para diciembre.
   */
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

const arMonth = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
});

/**
 * Primer mes que cuenta de una tarjeta: el que se agregó a la app. Lo que
 * vencía antes se da por pagado (igual que en los saldos), así las cuotas
 * viejas de una compra en cuotas no se quedan con los pagos nuevos.
 */
export const cardFloorMonth = (card: {
  createdAt?: { toDate(): Date } | Date | null;
}): string | undefined => {
  const d = !card.createdAt ? null : card.createdAt instanceof Date ? card.createdAt : card.createdAt.toDate();
  return d ? arMonth.format(d).slice(0, 7) : undefined;
};

/**
 * Resumen de un mes de pago. Para repartir bien los pagos (cada pago cubre el
 * resumen más viejo con deuda) conviene pasar TODOS los movimientos de la
 * tarjeta; con solo los del mes, cuenta los pagos de ese mes.
 */
export const summarizeCardMonth = (
  installments: Ins[],
  cardIds: Set<string> | string[],
  monthKey: string,
  taxCategoryIds: Set<string> = new Set(),
  /** Primer mes que cuenta (ver cardFloorMonth). */
  floorMonth?: string,
): CardMonthSummary => {
  const ids = cardIds instanceof Set ? cardIds : new Set(cardIds);
  // Total de cada resumen (desde floorMonth) y pagos hechos, por moneda.
  const monthTotals = new Map<string, Money>();
  const payments = zero();
  for (const i of installments) {
    if (!ids.has(i.accountId)) continue;
    const c = currencyOf(i);
    if (i.kind === "transfer") {
      if (i.transferRole === "destination") payments[c] += i.amount;
      continue;
    }
    const m = monthOf(i);
    if (floorMonth && m < floorMonth) continue;
    const t = monthTotals.get(m) ?? zero();
    if (i.kind === "expense") t[c] += i.amount;
    else if (isCardCredit(i)) t[c] -= i.amount;
    monthTotals.set(m, t);
  }
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
    }
  }
  const total: Money = { ARS: s.expenses.ARS - s.credits.ARS, USD: s.expenses.USD - s.credits.USD };
  // Reparto de pagos: lo pagado cubre primero los resúmenes anteriores con deuda.
  // Antes de floorMonth, todo se da por pagado.
  const beforeFloor = !!floorMonth && monthKey < floorMonth;
  for (const c of ["ARS", "USD"] as const) {
    if (beforeFloor) {
      s.paid[c] = Math.max(0, total[c]);
      continue;
    }
    let earlier = 0;
    for (const [m, t] of monthTotals) if (m < monthKey) earlier += Math.max(0, t[c]);
    const available = Math.max(0, payments[c] - earlier);
    s.paid[c] = Math.min(available, Math.max(0, total[c]));
  }
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

/**
 * El resumen que toca pagar: el primero (desde que se agregó la tarjeta hasta
 * el del mes que viene) que tenga algo pendiente, o null si está al día.
 */
export const cardStatementToPay = (
  installments: Ins[],
  card: { id: string; createdAt?: { toDate(): Date } | Date | null },
  currentMonth: string,
): { monthKey: string; summary: CardMonthSummary } | null => {
  const floor = cardFloorMonth(card);
  const months = new Set<string>();
  for (const i of installments) {
    if (i.accountId !== card.id || i.kind === "transfer") continue;
    const m = monthOf(i);
    if ((!floor || m >= floor) && m <= nextMonthKey(currentMonth)) months.add(m);
  }
  for (const m of [...months].sort()) {
    const summary = summarizeCardMonth(installments, [card.id], m, new Set(), floor);
    if (summary.pending.ARS > 0.009 || summary.pending.USD > 0.009) return { monthKey: m, summary };
  }
  return null;
};
