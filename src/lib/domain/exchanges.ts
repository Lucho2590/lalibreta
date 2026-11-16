import type { Currency, Installment } from "./types";
import { currencyOf } from "./types";

/**
 * Cambios de moneda (vender/comprar dólares). Funciones puras: las usan la
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
  usd: number;
  ars: number;
  /** Pesos por dólar (efectiva: lo que realmente se movió). */
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
  usd: number;
  ars: number;
  /** Cotización promedio ponderada (pesos / dólares). */
  avgRate: number;
  count: number;
  /** Suma de diferencias por redondeo/comisión, en pesos. Positivo = a favor. */
  diff: number;
}

export interface ExchangeSummary {
  sold: ExchangeSide;
  bought: ExchangeSide;
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
export const exchangeDiffOf = (side: "sell" | "buy", usd: number, quotedRate: number, ars: number): number => {
  const expected = usd * quotedRate;
  const d = r2(side === "sell" ? ars - expected : expected - ars);
  return Math.abs(d) < 0.01 ? 0 : d;
};

export const isExchangeLeg = (i: Pick<LegLike, "kind" | "transferType">) =>
  i.kind === "transfer" && i.transferType === "exchange";

/** Arma los cambios a partir de las patas (installments) de un período. */
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
    if (from === to) continue;
    const side = from === "USD" ? "sell" : "buy";
    const usd = side === "sell" ? source.amount : destination.amount;
    const ars = side === "sell" ? destination.amount : source.amount;
    if (!(usd > 0)) continue;
    ops.push({
      transactionId,
      date: source.billingDate.toDate(),
      side,
      usd,
      ars,
      rate: r2(ars / usd),
      quotedRate: source.exchangeDiff ? (source.quotedRate ?? null) : null,
      diff: source.exchangeDiff ?? 0,
      description: source.description,
      fromAccountId: source.accountId,
      toAccountId: destination.accountId,
    });
  }
  return ops.sort((a, b) => b.date.getTime() - a.date.getTime());
};

const sideOf = (ops: ExchangeOp[]): ExchangeSide => {
  const usd = r2(ops.reduce((s, o) => s + o.usd, 0));
  const ars = r2(ops.reduce((s, o) => s + o.ars, 0));
  const diff = r2(ops.reduce((s, o) => s + o.diff, 0));
  return { usd, ars, avgRate: usd > 0 ? r2(ars / usd) : 0, count: ops.length, diff };
};

export const summarizeExchanges = (installments: LegLike[]): ExchangeSummary => {
  const ops = listExchanges(installments);
  return {
    sold: sideOf(ops.filter((o) => o.side === "sell")),
    bought: sideOf(ops.filter((o) => o.side === "buy")),
    ops,
  };
};
