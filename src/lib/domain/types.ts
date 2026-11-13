import type { Timestamp } from "firebase/firestore";

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Contact {
  id: string;
  email: string;
  displayName?: string | null;
  linkedUid?: string | null;
  photoURL?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export type ShareParticipantStatus =
  | "owner"
  | "pending"
  | "accepted"
  | "rejected";

export interface ShareParticipant {
  uid: string | null;
  email: string;
  displayName?: string | null;
  percentage: number;
  amount: number;
  status: ShareParticipantStatus;
  respondedAt?: Timestamp | null;
}

export type SharedExpenseStatus = "active" | "cancelled";

// === Cuentas con extensión ===

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

export interface SharedExpense {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName?: string | null;
  description: string;
  totalAmount: number;
  date: Timestamp;
  ownerTransactionId?: string;
  participants: ShareParticipant[];
  participantUids: string[];
  participantEmails: string[];
  status: SharedExpenseStatus;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
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

export type Currency = "ARS" | "USD";
export const CURRENCIES: Currency[] = ["ARS", "USD"];

/** Los docs viejos no tienen moneda: son pesos. */
export const currencyOf = (x: { currency?: Currency | null }): Currency =>
  x.currency ?? "ARS";

/** Monedas que maneja una cuenta. Las tarjetas de crédito aceptan ambas. */
export const accountCurrencies = (a: {
  type: AccountType;
  currencies?: Currency[] | null;
}): Currency[] =>
  a.type === "credit" ? CURRENCIES : a.currencies?.length ? a.currencies : ["ARS"];

/**
 * Tipo de transferencia:
 * - transfer: mover plata entre cuentas (misma moneda)
 * - exchange: cambio de moneda (vender/comprar dólares), puede ser en la misma cuenta
 * - card-payment: pago de una tarjeta de crédito desde una cuenta
 */
export type TransferType = "transfer" | "exchange" | "card-payment";

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
  rate?: number;
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
  currency: "ARS" | "USD";
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
