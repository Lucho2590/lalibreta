import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import {
  computeMonthlyBalance,
  makeToARS,
  sumByAccount,
  sumByCategory,
  type FxRatesMap,
  type SharedAdjustment,
} from "@/lib/domain/balance";
import {
  computeAccountBalances,
  totalAvailable,
  type Money,
} from "@/lib/domain/balances";
import { buildSplitAdjustment } from "@/lib/domain/debts";
import { isPersonAccountId, type PersonTransfer, type Split } from "@/lib/domain/people";
import { summarizeExchanges } from "@/lib/domain/exchanges";
import type {
  AccountType,
  CategoryKind,
  Currency,
  Installment,
} from "@/lib/domain/types";
import { CURRENCIES, accountCurrencies, currencyOf, zeroMoney } from "@/lib/domain/types";
import { getOrBuildCycle, type ServerAccount } from "./transactions-admin";

/**
 * Lecturas del lado del server (Admin SDK) para el agente. Reutiliza las
 * mismas funciones puras que el dashboard (balance.ts / shared-effective.ts)
 * para que los números coincidan con la web.
 */

export interface ServerAccountInfo {
  id: string;
  name: string;
  type: AccountType;
  active: boolean;
  parentId: string | null;
  defaultClosingDay?: number;
  defaultDueDay?: number;
  last4: string | null;
  /** Monedas de la cuenta (tarjetas: ARS y USD). */
  currencies: Currency[];
  isMain: boolean;
  openingBalances: Partial<Record<Currency, number>> | null;
  createdAt: Date | null;
}

export interface ServerCategoryInfo {
  id: string;
  name: string;
  kind: CategoryKind;
}

export const loadAccounts = async (uid: string): Promise<ServerAccountInfo[]> => {
  const snap = await adminDb().collection(`users/${uid}/accounts`).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: String(data.name ?? ""),
      type: data.type as AccountType,
      active: data.active !== false,
      parentId: (data.parentId as string | null | undefined) ?? null,
      defaultClosingDay: data.defaultClosingDay as number | undefined,
      defaultDueDay: data.defaultDueDay as number | undefined,
      last4: (data.last4 as string | null | undefined) ?? null,
      currencies: accountCurrencies({
        type: data.type as AccountType,
        currencies: data.currencies as Currency[] | undefined,
      }),
      isMain: data.isMain === true,
      openingBalances: (data.openingBalances as Partial<Record<Currency, number>> | undefined) ?? null,
      createdAt: (data.createdAt as Timestamp | undefined)?.toDate() ?? null,
    };
  });
};

export interface ServerRecurringInfo {
  name: string;
  amount: number;
  currency: Currency;
  kind: string;
  dayOfMonth: number;
  accountId: string;
  active: boolean;
}

export const loadRecurring = async (uid: string): Promise<ServerRecurringInfo[]> => {
  const snap = await adminDb().collection(`users/${uid}/recurring`).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      name: String(data.name ?? ""),
      amount: Number(data.amount ?? 0),
      currency: currencyOf(data as { currency?: Currency }),
      kind: String(data.kind ?? "expense"),
      dayOfMonth: Number(data.dayOfMonth ?? 1),
      accountId: String(data.accountId ?? ""),
      active: data.active !== false,
    };
  });
};

export const loadCategories = async (
  uid: string,
): Promise<ServerCategoryInfo[]> => {
  const snap = await adminDb().collection(`users/${uid}/categories`).get();
  return snap.docs
    .map((d) => ({
      id: d.id,
      name: String(d.data().name ?? ""),
      kind: (d.data().kind as CategoryKind) ?? "expense",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
};

export const toServerAccount = (a: ServerAccountInfo): ServerAccount => ({
  id: a.id,
  type: a.type,
  defaultClosingDay: a.defaultClosingDay,
  defaultDueDay: a.defaultDueDay,
});

// Los tipos de dominio usan el Timestamp del SDK cliente; para las funciones
// puras de balance solo importan amount/kind/billingMonth/ids, así que
// casteamos los docs del Admin SDK.
const loadInstallmentsForMonth = async (
  uid: string,
  monthKey: string,
): Promise<Installment[]> => {
  const snap = await adminDb()
    .collection(`users/${uid}/installments`)
    .where("paymentMonth", "==", monthKey)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as Installment);
};

/** Gastos repartidos: qué parte de cada gasto mío es realmente mía. */
const loadSharedAdjustment = async (uid: string): Promise<SharedAdjustment> => {
  const [splits, transfers] = await Promise.all([
    adminDb().collection("splits").where("uids", "array-contains", uid).get(),
    adminDb().collection("p2pTransfers").where("uids", "array-contains", uid).get(),
  ]);
  return {
    byTxId: buildSplitAdjustment(
      uid,
      splits.docs.map((d) => ({ id: d.id, ...d.data() }) as Split),
      transfers.docs.map((d) => ({ id: d.id, ...d.data() }) as PersonTransfer),
    ),
  };
};

export interface NamedTotal {
  name: string;
  total: number;
}

export interface MonthSummary {
  month: string;
  /**
   * Ingresos/gastos/balance por moneda (las transferencias y cambios no
   * cuentan). Siempre ARS; las demás, solo si tuvieron movimientos.
   */
  byCurrency: Partial<Record<Currency, { income: number; expense: number; balance: number }>>;
  /** Gastos por categoría y por cuenta, en pesos (las otras monedas convertidas a ratesUsed). */
  byCategoryARS: NamedTotal[];
  byAccountARS: NamedTotal[];
  /** Pesos por unidad usados para convertir (BCRA oficial). */
  ratesUsed: FxRatesMap | null;
  movements: number;
  /** Cambios de moneda del mes (sin filtro de categoría; con filtro de cuenta, los que la tocan). */
  exchanges: {
    byCurrency: Array<{
      currency: Currency;
      sold: { amount: number; ars: number; avgRate: number; count: number; diff: number };
      bought: { amount: number; ars: number; avgRate: number; count: number; diff: number };
    }>;
    list: Array<{
      date: string;
      side: "sell" | "buy";
      currency: Currency;
      amount: number;
      ars: number;
      rate: number;
      /** Cotización pactada y diferencia en pesos (redondeo/comisión), si hubo. */
      quotedRate?: number;
      diff?: number;
      description: string;
      from: string;
      to: string;
    }>;
  } | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export const getMonthSummary = async (
  uid: string,
  monthKey: string,
  filter: { categoryId?: string; accountId?: string } = {},
  rates: FxRatesMap | null = null,
): Promise<MonthSummary> => {
  const [all, adj, accounts, categories] = await Promise.all([
    loadInstallmentsForMonth(uid, monthKey),
    loadSharedAdjustment(uid),
    loadAccounts(uid),
    loadCategories(uid),
  ]);
  const installments = all.filter(
    (i) =>
      (!filter.categoryId || i.categoryId === filter.categoryId) &&
      (!filter.accountId || i.accountId === filter.accountId),
  );

  const byCurrency = {} as MonthSummary["byCurrency"];
  for (const c of CURRENCIES) {
    const b = computeMonthlyBalance(installments, monthKey, adj, c);
    if (c !== "ARS" && b.income === 0 && b.expense === 0) continue;
    byCurrency[c] = { income: r2(b.income), expense: r2(b.expense), balance: r2(b.balance) };
  }
  const toARS = makeToARS(rates);
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const toNamed = (m: Map<string, number>, names: Map<string, string>) =>
    [...m.entries()]
      .map(([id, total]) => ({
        name: names.get(id) ?? (isPersonAccountId(id) ? "Tu parte de gastos que pagó otra persona" : "Sin nombre"),
        total: r2(total),
      }))
      .sort((a, b) => b.total - a.total);

  // Cambios: las dos patas de cada uno (con filtro de cuenta, si alguna es de esa cuenta).
  const txIds = filter.accountId
    ? new Set(all.filter((i) => i.accountId === filter.accountId).map((i) => i.transactionId))
    : null;
  const ex = filter.categoryId
    ? null
    : summarizeExchanges(all.filter((i) => !txIds || txIds.has(i.transactionId)));
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

  return {
    month: monthKey,
    byCurrency,
    exchanges:
      ex && ex.ops.length > 0
        ? {
            byCurrency: ex.byCurrency.map(({ currency, sold, bought }) => ({
              currency,
              sold: { amount: sold.amount, ars: sold.ars, avgRate: sold.avgRate, count: sold.count, diff: sold.diff },
              bought: {
                amount: bought.amount,
                ars: bought.ars,
                avgRate: bought.avgRate,
                count: bought.count,
                diff: bought.diff,
              },
            })),
            list: ex.ops.slice(0, 20).map((o) => ({
              date: ymd.format(o.date),
              side: o.side,
              currency: o.currency,
              amount: o.amount,
              ars: o.ars,
              rate: o.rate,
              ...(o.diff ? { quotedRate: o.quotedRate ?? undefined, diff: o.diff } : {}),
              description: o.description,
              from: accName.get(o.fromAccountId) ?? "—",
              to: accName.get(o.toAccountId) ?? "—",
            })),
          }
        : null,
    byCategoryARS: toNamed(sumByCategory(installments, monthKey, adj, toARS), catName),
    byAccountARS: toNamed(sumByAccount(installments, monthKey, adj, toARS), accName),
    ratesUsed: rates,
    movements: installments.filter((i) => i.kind !== "transfer").length,
  };
};

// === Saldos ===

const loadAllInstallments = async (uid: string): Promise<Installment[]> => {
  const snap = await adminDb().collection(`users/${uid}/installments`).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as Installment);
};

export interface BalancesSnapshot {
  accounts: Array<{
    id: string;
    name: string;
    type: AccountType;
    isMain: boolean;
    /** Cuentas: saldo. Tarjetas: lo que se debe. */
    amounts: Money;
  }>;
  /** Suma de las cuentas (sin tarjetas). */
  available: Money;
  /** Suma de lo que se debe de tarjetas. */
  cardDebt: Money;
}

export const getBalances = async (
  uid: string,
  accounts?: ServerAccountInfo[],
): Promise<BalancesSnapshot> => {
  const [accs, installments] = await Promise.all([
    accounts ? Promise.resolve(accounts) : loadAccounts(uid),
    loadAllInstallments(uid),
  ]);
  const active = accs.filter((a) => a.active);
  const balances = computeAccountBalances(active, installments);
  const cardDebt: Money = zeroMoney();
  for (const a of active) {
    if (a.type !== "credit") continue;
    const b = balances.get(a.id)!;
    for (const c of CURRENCIES) cardDebt[c] = r2(cardDebt[c] + b.amounts[c]);
  }
  return {
    accounts: active.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      isMain: a.isMain,
      amounts: balances.get(a.id)!.amounts,
    })),
    available: totalAvailable(active, balances),
    cardDebt,
  };
};

export interface CardStatement {
  accountName: string;
  month: string;
  /** Las tarjetas liquidan en pesos y dólares. */
  totals: { ARS: number; USD: number };
  dueDate: Date;
  items: Array<{
    description: string;
    amount: number;
    currency: Currency;
    installment: string;
  }>;
}

/** Lo que se paga de una tarjeta en un mes (montos completos, sin descontar compartidos). */
export const getCardStatement = async (
  uid: string,
  account: ServerAccountInfo,
  monthKey: string,
): Promise<CardStatement> => {
  const installments = (await loadInstallmentsForMonth(uid, monthKey)).filter(
    (i) => i.accountId === account.id && (i.kind === "expense" || (i.kind === "income" && i.cardCredit)),
  );
  // monthKey es el mes de PAGO: el vencimiento sale de las cuotas o, si no
  // hay, del resumen que cerró el mes anterior.
  let dueDate = installments
    .map((i) => (i.billingDate as unknown as Timestamp | undefined)?.toDate())
    .find((d): d is Date => !!d);
  if (!dueDate) {
    const [y, m] = monthKey.split("-").map(Number);
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    dueDate = (await getOrBuildCycle(uid, toServerAccount(account), prev.y, prev.m)).dueDate.toDate();
  }
  const totals = zeroMoney();
  for (const i of installments) totals[currencyOf(i)] += i.kind === "income" ? -i.amount : i.amount;
  return {
    accountName: account.name,
    month: monthKey,
    totals: { ARS: r2(totals.ARS), USD: r2(totals.USD) },
    dueDate,
    items: installments
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 30)
      .map((i) => ({
        description: i.description,
        amount: i.amount,
        currency: currencyOf(i),
        installment: `${i.installmentNumber}/${i.totalInstallments}`,
      })),
  };
};

export interface RecentTransaction {
  date: Date;
  kind: string;
  description: string;
  amount: number;
  currency: Currency;
  installments: number;
  accountName: string;
  categoryName: string;
  /**
   * Mes ("YYYY-MM") en que aparece en la app: el del vencimiento del resumen
   * para los gastos con tarjeta (la 1ª cuota), el de la fecha para el resto.
   */
  shownInMonth?: string;
  /** Tarjeta: vencimiento del resumen donde entra (la 1ª cuota). */
  dueDate?: Date;
  /** Transferencias y cambios: destino, tipo y (en un cambio) lo que entró y la cotización. */
  transfer?: {
    type: string;
    toAccountName: string;
    toAmount?: number;
    toCurrency?: Currency;
    rate?: number;
  };
}

export const listRecentTransactions = async (
  uid: string,
  limit: number,
): Promise<RecentTransaction[]> => {
  const [snap, accounts, categories] = await Promise.all([
    adminDb()
      .collection(`users/${uid}/transactions`)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get(),
    loadAccounts(uid),
    loadCategories(uid),
  ]);
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  // Primera cuota de cada movimiento: dice en qué mes se ve en la app.
  const firstInstallment = new Map<string, FirebaseFirestore.DocumentData>();
  const ids = snap.docs.map((d) => d.id);
  if (ids.length) {
    const ins = await adminDb()
      .collection(`users/${uid}/installments`)
      .where("transactionId", "in", ids)
      .get();
    for (const i of ins.docs) {
      const data = i.data();
      if (Number(data.installmentNumber ?? 1) === 1) firstInstallment.set(String(data.transactionId), data);
    }
  }
  const creditIds = new Set(accounts.filter((a) => a.type === "credit").map((a) => a.id));
  return snap.docs.map((d) => {
    const t = d.data();
    const first = firstInstallment.get(d.id);
    const onCard = creditIds.has(t.accountId as string) && t.kind !== "transfer";
    return {
      ...(first?.paymentMonth ? { shownInMonth: String(first.paymentMonth) } : {}),
      ...(onCard && first?.billingDate ? { dueDate: (first.billingDate as Timestamp).toDate() } : {}),
      date: (t.purchaseDate as Timestamp).toDate(),
      kind: String(t.kind),
      description: String(t.description ?? ""),
      amount: Number(t.totalAmount ?? 0),
      currency: currencyOf(t as { currency?: Currency }),
      installments: Number(t.installments ?? 1),
      accountName:
        accName.get(t.accountId as string) ??
        (isPersonAccountId(t.accountId as string) ? "(pagó otra persona)" : "—"),
      categoryName: catName.get(t.categoryId as string) ?? "—",
      ...(t.kind === "transfer"
        ? {
            transfer: {
              type: String(t.transferType ?? "transfer"),
              toAccountName: accName.get(t.toAccountId as string) ?? "—",
              ...(t.toAmount != null
                ? { toAmount: Number(t.toAmount), toCurrency: t.toCurrency as Currency }
                : {}),
              ...(t.rate != null ? { rate: Number(t.rate) } : {}),
            },
          }
        : {}),
    };
  });
};
