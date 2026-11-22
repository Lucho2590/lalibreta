import type { Timestamp } from "firebase/firestore";
import type { ContactInfoFields } from "./contact-info";

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Contact extends ContactInfoFields {
  id: string;
  /** Los contactos sin la app pueden no tener email. */
  email?: string | null;
  phone?: string | null;
  /** "app": usuario conectado; "offline": no usa la app. */
  kind?: "app" | "offline" | null;
  displayName?: string | null;
  linkedUid?: string | null;
  photoURL?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}



// === Cuentas con extensión ===

export type ShareVisibility = "own" | "all";

export interface AccountShare {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName?: string | null;
  accountId: string;
  accountName: string;
  accountIcon?: string | null;
  accountType: AccountType;
  granteeEmail: string;
  granteeUid?: string | null;
  granteeDisplayName?: string | null;
  status: "active" | "revoked";
  /** "direct" (compartidas por WhatsApp): lo que carga el invitado entra sin aprobación. */
  mode?: "direct" | "approval";
  /** Qué ve el invitado de la cuenta: solo lo que cargó él (por defecto) o todos los gastos. */
  visibility?: ShareVisibility;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface PendingApproval {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  granteeUid: string;
  granteeEmail: string;
  granteeDisplayName?: string | null;
  accountId: string;
  accountName: string;
  shareId: string;
  description: string;
  totalAmount: number;
  purchaseDate: Timestamp;
  installments: number;
  cardClosedAtPurchase: boolean;
  status: ApprovalStatus;
  approvedTransactionId?: string | null;
  approvedCategoryId?: string | null;
  rejectReason?: string | null;
  createdAt: Timestamp;
  respondedAt?: Timestamp | null;
}


export type AccountType =
  | "cash"
  | "debit"
  | "credit"
  | "checking"
  | "savings"
  | "digital"
  /** Cobacha: plata apartada dentro de otra cuenta (reservas de Mercado Pago, frascos de Naranja X…). */
  | "reserve";

export type TransactionKind = "expense" | "income" | "transfer";

// === Monedas ===

/**
 * Monedas que se pueden usar en cuentas. Es la única lista: para sumar otra,
 * agregarla acá (con su código del BCRA para la cotización).
 */
export const CURRENCY_META = {
  ARS: { symbol: "$", singular: "peso", plural: "Pesos", bcraCode: null },
  USD: { symbol: "US$", singular: "dólar", plural: "Dólares", bcraCode: "USD" },
  EUR: { symbol: "€", singular: "euro", plural: "Euros", bcraCode: "EUR" },
  GBP: { symbol: "£", singular: "libra", plural: "Libras", bcraCode: "GBP" },
  BRL: { symbol: "R$", singular: "real", plural: "Reales", bcraCode: "BRL" },
  UYU: { symbol: "$U", singular: "peso uruguayo", plural: "Pesos uruguayos", bcraCode: "UYU" },
  CLP: { symbol: "CLP$", singular: "peso chileno", plural: "Pesos chilenos", bcraCode: "CLP" },
} as const satisfies Record<
  string,
  { symbol: string; singular: string; plural: string; bcraCode: string | null }
>;

export type Currency = keyof typeof CURRENCY_META;
export const CURRENCIES = Object.keys(CURRENCY_META) as Currency[];
/** Monedas distintas del peso (las que se compran/venden y se pasan a pesos con cotización). */
export const FOREIGN_CURRENCIES: Currency[] = CURRENCIES.filter((c) => c !== "ARS");
/** Las tarjetas de crédito argentinas liquidan en pesos y dólares. */
export const CARD_CURRENCIES: Currency[] = ["ARS", "USD"];

export const isCurrency = (x: unknown): x is Currency =>
  typeof x === "string" && x in CURRENCY_META;

/** { ARS: 0, USD: 0, EUR: 0, … } */
export const zeroMoney = (): Record<Currency, number> =>
  Object.fromEntries(CURRENCIES.map((c) => [c, 0])) as Record<Currency, number>;

/** Monedas con monto distinto de cero, en el orden de CURRENCIES. */
export const nonZeroCurrencies = (m: Partial<Record<Currency, number>>): Currency[] =>
  CURRENCIES.filter((c) => Math.abs(m[c] ?? 0) >= 0.005);

/** Los docs viejos no tienen moneda: son pesos. */
export const currencyOf = (x: { currency?: Currency | null }): Currency =>
  x.currency ?? "ARS";

/** Monedas que maneja una cuenta. Las tarjetas de crédito aceptan pesos y dólares. */
export const accountCurrencies = (a: {
  type: AccountType;
  currencies?: Currency[] | null;
}): Currency[] =>
  a.type === "credit" ? CARD_CURRENCIES : a.currencies?.length ? a.currencies : ["ARS"];

/** Monedas que usa el usuario en alguna cuenta (siempre incluye pesos), en el orden de CURRENCIES. */
export const userCurrencies = (
  accounts: Array<{ type: AccountType; currencies?: Currency[] | null; active?: boolean }>,
): Currency[] =>
  CURRENCIES.filter(
    (c) => c === "ARS" || accounts.some((a) => a.active !== false && accountCurrencies(a).includes(c)),
  );

/**
 * Tipo de transferencia:
 * - transfer: mover plata entre cuentas (misma moneda)
 * - exchange: cambio de moneda (vender/comprar dólares), puede ser en la misma cuenta
 * - card-payment: pago de una tarjeta de crédito desde una cuenta
 * - p2p: plata que le pasé a una persona o que me pasó (una sola pata, con
 *   transferCounterpartId = "person:<ref>")
 */
export type TransferType = "transfer" | "exchange" | "card-payment" | "p2p";

export type CategoryKind = "expense" | "income";

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: CategoryKind;
  createdAt: Timestamp;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  icon?: string;
  color?: string;
  parentId?: string | null;
  active?: boolean;
  defaultClosingDay?: number;
  defaultDueDay?: number;
  /** Últimos 4 dígitos de la tarjeta (los carga el agente al leer un resumen). */
  last4?: string | null;
  /** Monedas de la cuenta (no aplica a tarjetas: aceptan ARS y USD). Default ["ARS"]. */
  currencies?: Currency[] | null;
  /** Cuenta principal del usuario (donde cobra). Una sola. */
  isMain?: boolean | null;
  /** Saldo con el que arranca la cuenta, por moneda. */
  openingBalances?: Partial<Record<Currency, number>> | null;
  openingDate?: Timestamp | null;
  /** Orden elegido por el usuario (arrastrar y soltar). Menor = más arriba. */
  sortOrder?: number | null;
  createdAt: Timestamp;
}

export interface CardCycle {
  id: string;
  year: number;
  month: number;
  closingDate: Timestamp;
  dueDate: Timestamp;
}

export interface Transaction {
  id: string;
  accountId: string;
  categoryId: string;
  description: string;
  totalAmount: number;
  purchaseDate: Timestamp;
  kind: TransactionKind;
  installments: number;
  cardClosedAtPurchase?: boolean;
  firstBillingMonth?: string;
  recurringId?: string;
  toAccountId?: string;
  /** Moneda de totalAmount. Default ARS. */
  currency?: Currency;
  /** Transferencias: tipo, y para cambios de moneda, moneda/monto de destino y cotización. */
  transferType?: TransferType;
  toCurrency?: Currency;
  toAmount?: number;
  /** Cotización efectiva (pesos por dólar que realmente se movieron). */
  rate?: number;
  /** Cambios: cotización pactada, si difiere de la efectiva (redondeo, comisión, cambio parcial). */
  quotedRate?: number;
  /** Cambios: diferencia en pesos contra dólares × cotización pactada. Positivo = a favor. */
  exchangeDiff?: number;
  /** Mi parte de un gasto que pagó otra persona (splits/{splitId}). */
  splitId?: string;
  /** Transferencia con una persona (p2pTransfers/{id}). */
  p2pTransferId?: string;
  /** Vaquita: gasto o pago de la vaquita que lo generó (se edita desde ahí). */
  vaquitaId?: string;
  vaquitaExpenseId?: string;
  vaquitaPaymentId?: string;
  /** Parte del gasto que es mía (0..1): lo pagué yo pero era de varios. Default 1. */
  shareFactor?: number;
  createdAt: Timestamp;
}

export interface RecurringExpense {
  id: string;
  name: string;
  amount: number;
  accountId: string;
  categoryId: string;
  kind: TransactionKind;
  currency?: Currency;
  dayOfMonth: number;
  startMonth: string;
  endMonth?: string | null;
  active: boolean;
  createdAt: Timestamp;
}

export interface Installment {
  id: string;
  transactionId: string;
  accountId: string;
  categoryId: string;
  amount: number;
  billingMonth: string;
  billingDate: Timestamp;
  installmentNumber: number;
  totalInstallments: number;
  kind: TransactionKind;
  description: string;
  recurringId?: string;
  transferRole?: "source" | "destination";
  transferCounterpartId?: string;
  transferType?: TransferType;
  /** Cambios: cotización pactada y diferencia en pesos (ver Transaction). */
  quotedRate?: number;
  exchangeDiff?: number;
  /** Mi parte de un gasto que pagó otra persona / transferencia con una persona. */
  splitId?: string;
  p2pTransferId?: string;
  /** Vaquita: gasto o pago de la vaquita que lo generó (se edita desde ahí). */
  vaquitaId?: string;
  vaquitaExpenseId?: string;
  vaquitaPaymentId?: string;
  /** Parte del gasto que es mía (0..1): lo pagué yo pero era de varios. Default 1. */
  shareFactor?: number;
  /** Moneda de amount. Default ARS. */
  currency?: Currency;
  /** Si lo cargó otra persona desde una cuenta compartida. */
  createdByName?: string;
  /**
   * Mes en que se paga (YYYY-MM): el de billingDate. Para tarjetas es el mes
   * del vencimiento del resumen (billingMonth es el del cierre); para el
   * resto coincide con billingMonth. Las pantallas agrupan por este mes.
   */
  paymentMonth?: string;
  /** Gasto estimado (suscripción proyectada al próximo resumen); se reemplaza al importar el real. */
  projected?: boolean;
  /**
   * Reintegro/bonificación en una TARJETA (kind "income"): no es plata que
   * entra, es saldo a favor que baja lo que se paga. En los balances resta
   * del gasto en vez de sumar como ingreso.
   */
  cardCredit?: boolean;
}

/** Ingreso de verdad (no un saldo a favor de tarjeta). */
export const isRealIncome = (i: { kind: string; cardCredit?: boolean }) =>
  i.kind === "income" && !i.cardCredit;
/** Saldo a favor en una tarjeta (reintegro, devolución, bonificación). */
export const isCardCredit = (i: { kind: string; cardCredit?: boolean }) =>
  i.kind === "income" && !!i.cardCredit;

export const monthKey = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, "0")}`;

export const parseMonthKey = (key: string): { year: number; month: number } => {
  const [y, m] = key.split("-").map(Number);
  return { year: y, month: m };
};

// === Resúmenes de tarjeta (los carga el agente de WhatsApp) ===

export type StatementLineType =
  | "purchase"
  | "installment"
  | "subscription"
  | "tax"
  | "fee"
  | "interest"
  | "payment"
  | "credit"
  | "other";

export interface StatementLine {
  /** YYYY-MM-DD, si el resumen la trae. */
  date: string | null;
  description: string;
  amount: number;
  currency: Currency;
  /** "3/6" para cuotas. */
  installment: string | null;
  type: StatementLineType;
}

/** users/{uid}/cardStatements/{accountId}_{YYYY-MM} */
export interface CardStatement {
  id: string;
  accountId: string;
  accountName: string;
  /** Mes del cierre (YYYY-MM): coincide con billingMonth de las cuotas. */
  period: string;
  closingDate: Timestamp;
  dueDate: Timestamp;
  nextClosingDate?: Timestamp | null;
  nextDueDate?: Timestamp | null;
  last4?: string | null;
  totalARS: number;
  totalUSD: number;
  minimumPayment?: number | null;
  /** Suma de impuestos + cargos + intereses en ARS. */
  chargesARS: number;
  lines: StatementLine[];
  chargesTransactionId?: string | null;
  createdAt: Timestamp;
}

// === Mes de pago ===

const arMonthFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
});

/** "YYYY-MM" de una fecha, en hora argentina. */
export const paymentMonthOf = (d: Date): string => arMonthFormatter.format(d).slice(0, 7);

/** Mes en que se paga una cuota (los docs viejos sin paymentMonth caen en billingMonth). */
export const monthOf = (ins: { paymentMonth?: string; billingMonth: string }): string =>
  ins.paymentMonth ?? ins.billingMonth;
