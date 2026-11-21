import type { Currency, Installment } from "./types";
import { CURRENCIES, FOREIGN_CURRENCIES, currencyOf } from "./types";

/**
 * Cambios de moneda (vender/comprar dólares, euros…, siempre contra pesos). Funciones puras: las usan la
 * web y el agente. Un cambio es una transferencia con dos patas en distinta
 * moneda (puede ser dentro de la misma cuenta o entre cuentas, ej. salen
 * dólares del Galicia y entran pesos en Mercado Pago). Los pagos de tarjeta
 * con otra moneda no cuentan como cambio.
 */

type LegLike = Pick<
  Installment,
  | "transactionId"
  | "accountId"
  | "amount"
  | "kind"
  | "transferRole"
  | "transferType"
  | "description"
  | "currency"
  | "quotedRate"
  | "exchangeDiff"
> & { billingDate: { toDate(): Date } };

export interface ExchangeOp {
  transactionId: string;
  date: Date;
  side: "sell" | "buy";
  /** Moneda extranjera que se vendió o compró. */
  currency: Currency;
  /** Cantidad de esa moneda. */
  amount: number;
  ars: number;
  /** Pesos por unidad (efectiva: lo que realmente se movió). */
  rate: number;
  /** Cotización pactada, si hubo diferencia (redondeo, comisión). */
  quotedRate: number | null;
  /** Diferencia en pesos contra la pactada. Positivo = a favor. */
  diff: number;
  description: string;
  fromAccountId: string;
  toAccountId: string;
}

export interface ExchangeSide {
  currency: Currency;
  /** Cantidad de moneda extranjera. */
  amount: number;
  ars: number;
  /** Cotización promedio ponderada (pesos / unidad). */
  avgRate: number;
  count: number;
  /** Suma de diferencias por redondeo/comisión, en pesos. Positivo = a favor. */
  diff: number;
}

export interface ExchangeCurrencySummary {
  currency: Currency;
  sold: ExchangeSide;
  bought: ExchangeSide;
}

export interface ExchangeSummary {
  /** Una entrada por moneda con cambios, en el orden de CURRENCIES. */
  byCurrency: ExchangeCurrencySummary[];
  /** Del más nuevo al más viejo. */
  ops: ExchangeOp[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Diferencia de un cambio contra la cotización pactada, en pesos y con signo
 * "a favor": vendiendo, recibir más pesos de lo esperado es a favor; comprando,
 * pagar menos. Ej.: vendo US$ 500 a 1.480 (esperado $ 740.000) y me entran
 * $ 739.650 → −350.
 */
export const exchangeDiffOf = (side: "sell" | "buy", amount: number, quotedRate: number, ars: number): number => {
  const expected = amount * quotedRate;
  const d = r2(side === "sell" ? ars - expected : expected - ars);
  return Math.abs(d) < 0.01 ? 0 : d;
};

export const isExchangeLeg = (i: Pick<LegLike, "kind" | "transferType">) =>
  i.kind === "transfer" && i.transferType === "exchange";

/**
 * Arma los cambios a partir de las patas (installments) de un período. Un
 * cambio es siempre moneda extranjera ↔ pesos; si salen pesos es una compra.
 */
export const listExchanges = (installments: LegLike[]): ExchangeOp[] => {
  const legs = new Map<string, { source?: LegLike; destination?: LegLike }>();
  for (const i of installments) {
    if (i.kind !== "transfer" || i.transferType === "card-payment") continue;
    const entry = legs.get(i.transactionId) ?? {};
    if (i.transferRole === "source") entry.source = i;
    else if (i.transferRole === "destination") entry.destination = i;
    legs.set(i.transactionId, entry);
  }
  const ops: ExchangeOp[] = [];
  for (const [transactionId, { source, destination }] of legs) {
    if (!source || !destination) continue;
    const from: Currency = currencyOf(source);
    const to: Currency = currencyOf(destination);
    if (from === to || (from !== "ARS" && to !== "ARS")) continue;
    const side = from === "ARS" ? "buy" : "sell";
    const currency = side === "sell" ? from : to;
    const amount = side === "sell" ? source.amount : destination.amount;
    const ars = side === "sell" ? destination.amount : source.amount;
    if (!(amount > 0)) continue;
    ops.push({
      transactionId,
      date: source.billingDate.toDate(),
      side,
      currency,
      amount,
      ars,
      rate: r2(ars / amount),
      quotedRate: source.exchangeDiff ? (source.quotedRate ?? null) : null,
      diff: source.exchangeDiff ?? 0,
      description: source.description,
      fromAccountId: source.accountId,
      toAccountId: destination.accountId,
    });
  }
  return ops.sort((a, b) => b.date.getTime() - a.date.getTime());
};

const sideOf = (currency: Currency, ops: ExchangeOp[]): ExchangeSide => {
  const amount = r2(ops.reduce((s, o) => s + o.amount, 0));
  const ars = r2(ops.reduce((s, o) => s + o.ars, 0));
  const diff = r2(ops.reduce((s, o) => s + o.diff, 0));
  return { currency, amount, ars, avgRate: amount > 0 ? r2(ars / amount) : 0, count: ops.length, diff };
};

export const summarizeExchanges = (installments: LegLike[]): ExchangeSummary => {
  const ops = listExchanges(installments);
  const byCurrency = CURRENCIES.flatMap((currency): ExchangeCurrencySummary[] => {
    const mine = ops.filter((o) => o.currency === currency);
    if (mine.length === 0) return [];
    return [
      {
        currency,
        sold: sideOf(currency, mine.filter((o) => o.side === "sell")),
        bought: sideOf(currency, mine.filter((o) => o.side === "buy")),
      },
    ];
  });
  return { byCurrency, ops };
};

export interface MonthRate {
  rate: number;
  label: string;
}

/**
 * A qué cotización pasar cada moneda extranjera del mes a pesos para el
 * balance "todo en pesos": la de venta del usuario en el mes (promedio); si no
 * vendió, la de compra; si no, la oficial del BCRA. Las monedas sin ninguna
 * de las tres no aparecen.
 */
export const monthRates = (
  installments: LegLike[],
  bcraRates: Partial<Record<Currency, number>> | null | undefined,
): Partial<Record<Currency, MonthRate>> => {
  const ex = summarizeExchanges(installments);
  const out: Partial<Record<Currency, MonthRate>> = {};
  for (const c of FOREIGN_CURRENCIES) {
    const mine = ex.byCurrency.find((x) => x.currency === c);
    if (mine?.sold.count) out[c] = { rate: mine.sold.avgRate, label: "tu promedio de venta del mes" };
    else if (mine?.bought.count) out[c] = { rate: mine.bought.avgRate, label: "tu promedio de compra del mes" };
    else if (bcraRates?.[c]) out[c] = { rate: bcraRates[c] as number, label: "oficial BCRA" };
  }
  return out;
};

/** Solo las cotizaciones de un resultado de monthRates. */
export const ratesOnly = (m: Partial<Record<Currency, MonthRate>>): Partial<Record<Currency, number>> =>
  Object.fromEntries(Object.entries(m).map(([c, r]) => [c, r.rate])) as Partial<Record<Currency, number>>;
