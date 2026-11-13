import type { Account, AccountType, Currency, Installment } from "./types";
import { CURRENCIES, accountCurrencies, currencyOf } from "./types";

/**
 * Saldos por cuenta y por moneda (funciones puras: las usan la web y el agente).
 *
 * - Cuentas (no tarjeta): saldo inicial + ingresos − gastos ± transferencias,
 *   cambios de moneda y pagos de tarjeta, contando solo lo que ya pasó.
 * - Tarjetas: lo que se debe = gastos de los resúmenes hasta el mes actual −
 *   pagos registrados.
 */

export type Money = Record<Currency, number>;

export const emptyMoney = (): Money => ({ ARS: 0, USD: 0 });

const round2 = (n: number) => Math.round(n * 100) / 100;

type AccountLike = Pick<Account, "id" | "type" | "currencies" | "openingBalances"> & {
  type: AccountType;
};

type InstallmentLike = Pick<
  Installment,
  "accountId" | "amount" | "kind" | "billingMonth" | "transferRole" | "currency"
> & { billingDate: { toDate(): Date } };

export interface AccountBalance {
  accountId: string;
  /** Cuentas: saldo disponible. Tarjetas: lo que se debe (positivo = deuda). */
  amounts: Money;
  isCard: boolean;
}

// Los movimientos se comparan por DÍA en hora argentina: uno de hoy cuenta
// todo el día (se guardan a las 12:00 AR).
const arDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const ymdAR = (d: Date) => arDay.format(d);

export const computeAccountBalances = (
  accounts: AccountLike[],
  installments: InstallmentLike[],
  now: Date = new Date(),
): Map<string, AccountBalance> => {
  const today = ymdAR(now);
  const currentMonth = today.slice(0, 7);
  const happened = (ins: InstallmentLike) => ymdAR(ins.billingDate.toDate()) <= today;
  const result = new Map<string, AccountBalance>();
  for (const a of accounts) {
    const amounts = emptyMoney();
    if (a.type !== "credit") {
      for (const c of CURRENCIES) amounts[c] += a.openingBalances?.[c] ?? 0;
    }
    result.set(a.id, { accountId: a.id, amounts, isCard: a.type === "credit" });
  }

  for (const ins of installments) {
    const bal = result.get(ins.accountId);
    if (!bal) continue;
    const cur = currencyOf(ins);

    if (bal.isCard) {
      // Deuda: gastos de resúmenes ya cerrados o en curso; los pagos la bajan.
      if (ins.kind === "expense" && ins.billingMonth <= currentMonth) bal.amounts[cur] += ins.amount;
      else if (ins.kind === "income" && ins.billingMonth <= currentMonth) bal.amounts[cur] -= ins.amount;
      else if (ins.kind === "transfer" && happened(ins)) {
        // Pago (entra a la tarjeta) baja la deuda; si sale plata de la tarjeta, sube.
        bal.amounts[cur] += ins.transferRole === "destination" ? -ins.amount : ins.amount;
      }
      continue;
    }

    // Cuentas: solo movimientos con fecha hasta hoy.
    if (!happened(ins)) continue;
    if (ins.kind === "income") bal.amounts[cur] += ins.amount;
    else if (ins.kind === "expense") bal.amounts[cur] -= ins.amount;
    else if (ins.kind === "transfer") {
      bal.amounts[cur] += ins.transferRole === "destination" ? ins.amount : -ins.amount;
    }
  }

  for (const b of result.values()) {
    for (const c of CURRENCIES) b.amounts[c] = round2(b.amounts[c]);
  }
  return result;
};

/** Total de las cuentas (sin tarjetas) por moneda. */
export const totalAvailable = (
  accounts: AccountLike[],
  balances: Map<string, AccountBalance>,
): Money => {
  const total = emptyMoney();
  for (const a of accounts) {
    if (a.type === "credit") continue;
    const b = balances.get(a.id);
    if (!b) continue;
    for (const c of CURRENCIES) total[c] += b.amounts[c];
  }
  for (const c of CURRENCIES) total[c] = round2(total[c]);
  return total;
};

/** Monedas que conviene mostrar de una cuenta: las suyas + cualquiera con saldo. */
export const visibleCurrencies = (a: AccountLike, b?: AccountBalance): Currency[] =>
  CURRENCIES.filter(
    (c) => (a.type !== "credit" && accountCurrencies(a).includes(c)) || (b && Math.abs(b.amounts[c]) >= 0.01),
  );
