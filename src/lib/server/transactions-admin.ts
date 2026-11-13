import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import type { AccountType, Currency, TransferType } from "@/lib/domain/types";
import { paymentMonthOf } from "@/lib/domain/types";

const lastDayOfMonth = (year: number, month: number) =>
  new Date(year, month, 0).getDate();

const clampDay = (year: number, month: number, day: number) =>
  Math.min(day, lastDayOfMonth(year, month));

const monthKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;

const addMonths = (year: number, month: number, n: number) => {
  const total = month - 1 + n;
  const newYear = year + Math.floor(total / 12);
  const newMonth = ((total % 12) + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
};

export interface ServerAccount {
  id: string;
  type: AccountType;
  defaultClosingDay?: number;
  defaultDueDay?: number;
}

interface CycleData {
  closingDate: Timestamp;
  dueDate: Timestamp;
}

const buildDefaultCycle = (
  account: ServerAccount,
  year: number,
  month: number,
): CycleData => {
  const closingDay = clampDay(year, month, account.defaultClosingDay ?? 1);
  const closingDate = new Date(year, month - 1, closingDay, 23, 59, 59);

  const dueDay = account.defaultDueDay ?? closingDay;
  let dueYear = year;
  let dueMonth = month;
  if (dueDay <= closingDay) {
    dueMonth = month + 1;
    if (dueMonth > 12) {
      dueMonth = 1;
      dueYear += 1;
    }
  }
  const dueDate = new Date(
    dueYear,
    dueMonth - 1,
    clampDay(dueYear, dueMonth, dueDay),
    12,
    0,
    0,
  );
  return {
    closingDate: Timestamp.fromDate(closingDate),
    dueDate: Timestamp.fromDate(dueDate),
  };
};

export const getOrBuildCycle = async (
  uid: string,
  account: ServerAccount,
  year: number,
  month: number,
): Promise<CycleData> => {
  const key = monthKey(year, month);
  const ref = adminDb()
    .collection(`users/${uid}/accounts/${account.id}/cycles`)
    .doc(key);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() as { closingDate: Timestamp; dueDate: Timestamp };
    return { closingDate: data.closingDate, dueDate: data.dueDate };
  }
  return buildDefaultCycle(account, year, month);
};

const computeFirstBillingMonth = (
  account: ServerAccount,
  purchaseDate: Date,
  cardClosedAtPurchase: boolean,
) => {
  const year = purchaseDate.getFullYear();
  const month = purchaseDate.getMonth() + 1;
  const closingDay = clampDay(year, month, account.defaultClosingDay ?? 1);
  const purchaseDay = purchaseDate.getDate();
  const movesToNext = cardClosedAtPurchase || purchaseDay > closingDay;
  if (!movesToNext) return { year, month };
  return addMonths(year, month, 1);
};

export interface ServerCreateInput {
  ownerUid: string;
  account: ServerAccount;
  accountId: string;
  categoryId: string;
  description: string;
  totalAmount: number;
  purchaseDate: Date;
  kind: "expense" | "income";
  installments: number;
  cardClosedAtPurchase?: boolean;
  /**
   * Fuerza el mes del primer resumen ("YYYY-MM"). Lo usa el agente para los
   * cargos de un resumen: van al mes de ese cierre aunque el día de cierre
   * real no coincida con el configurado en la cuenta.
   */
  forceFirstBillingMonth?: string;
  /** Moneda del monto. Default ARS. */
  currency?: Currency;
  recurringId?: string;
  /** Si lo cargó otra persona sobre una cuenta compartida. */
  createdBy?: { uid: string; name: string };
  /** Gasto estimado (ej. suscripción proyectada al próximo resumen). */
  projected?: boolean;
}

export const createTransactionAdmin = async (
  input: ServerCreateInput,
): Promise<string> => {
  // Los ingresos nunca van en cuotas ni siguen el ciclo de la tarjeta.
  const isCredit = input.account.type === "credit" && input.kind === "expense";
  // En una tarjeta, gastos Y reintegros van al resumen (mes del cierre y fecha
  // de vencimiento). Las cuotas son solo para gastos.
  const followsCardCycle = input.account.type === "credit";
  const installmentsCount = isCredit ? Math.max(1, input.installments) : 1;
  const amountPerInstallment =
    Math.round((input.totalAmount / installmentsCount) * 100) / 100;

  const txCol = adminDb().collection(`users/${input.ownerUid}/transactions`);

  const txRef = txCol.doc();

  let firstYear: number;
  let firstMonth: number;
  if (followsCardCycle && input.forceFirstBillingMonth) {
    [firstYear, firstMonth] = input.forceFirstBillingMonth.split("-").map(Number);
  } else if (followsCardCycle) {
    const first = computeFirstBillingMonth(
      input.account,
      input.purchaseDate,
      input.cardClosedAtPurchase ?? false,
    );
    firstYear = first.year;
    firstMonth = first.month;
  } else {
    firstYear = input.purchaseDate.getFullYear();
    firstMonth = input.purchaseDate.getMonth() + 1;
  }

  const batch = adminDb().batch();

  batch.set(txRef, {
    accountId: input.accountId,
    categoryId: input.categoryId,
    description: input.description,
    totalAmount: input.totalAmount,
    purchaseDate: Timestamp.fromDate(input.purchaseDate),
    kind: input.kind,
    installments: installmentsCount,
    cardClosedAtPurchase: isCredit ? input.cardClosedAtPurchase ?? false : false,
    firstBillingMonth: monthKey(firstYear, firstMonth),
    currency: input.currency ?? "ARS",
    ...(input.recurringId ? { recurringId: input.recurringId } : {}),
    ...(input.createdBy ? { createdByUid: input.createdBy.uid, createdByName: input.createdBy.name } : {}),
    ...(input.projected ? { projected: true } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });

  await writeInstallments(batch, input.ownerUid, input.account, {
    transactionId: txRef.id,
    accountId: input.accountId,
    categoryId: input.categoryId,
    description: input.description,
    kind: input.kind,
    purchaseDate: input.purchaseDate,
    firstYear,
    firstMonth,
    installmentsCount,
    amountPerInstallment,
    isCredit: followsCardCycle,
    currency: input.currency ?? "ARS",
    recurringId: input.recurringId,
    createdByName: input.createdBy?.name,
    projected: input.projected,
  });

  await batch.commit();
  return txRef.id;
};

interface InstallmentSpec {
  transactionId: string;
  accountId: string;
  categoryId: string;
  description: string;
  kind: string;
  purchaseDate: Date;
  firstYear: number;
  firstMonth: number;
  installmentsCount: number;
  amountPerInstallment: number;
  isCredit: boolean;
  currency: Currency;
  recurringId?: string;
  createdByName?: string;
  projected?: boolean;
}

const writeInstallments = async (
  batch: FirebaseFirestore.WriteBatch,
  uid: string,
  account: ServerAccount,
  spec: InstallmentSpec,
) => {
  const insCol = adminDb().collection(`users/${uid}/installments`);
  for (let i = 0; i < spec.installmentsCount; i += 1) {
    const { year, month } = addMonths(spec.firstYear, spec.firstMonth, i);
    let billingDate: Date;
    if (spec.isCredit) {
      const cycle = await getOrBuildCycle(uid, account, year, month);
      billingDate = cycle.dueDate.toDate();
    } else {
      billingDate = spec.purchaseDate;
    }
    batch.set(insCol.doc(), {
      transactionId: spec.transactionId,
      accountId: spec.accountId,
      categoryId: spec.categoryId,
      amount: spec.amountPerInstallment,
      billingMonth: monthKey(year, month),
      billingDate: Timestamp.fromDate(billingDate),
      paymentMonth: paymentMonthOf(billingDate),
      installmentNumber: i + 1,
      totalInstallments: spec.installmentsCount,
      kind: spec.kind,
      description: spec.description,
      currency: spec.currency,
      ...(spec.recurringId ? { recurringId: spec.recurringId } : {}),
      ...(spec.createdByName ? { createdByName: spec.createdByName } : {}),
      ...(spec.projected ? { projected: true } : {}),
      // Plata que "entra" a una tarjeta = saldo a favor, no ingreso.
      ...(spec.isCredit && spec.kind === "income" ? { cardCredit: true } : {}),
    });
  }
};

/**
 * Rearma las cuotas de todos los gastos de una tarjeta con sus días de
 * cierre/vencimiento actuales. Se usa cuando una tarjeta se creó sin fechas
 * y el usuario las completa después: los gastos cargados mientras tanto
 * pasan al resumen que corresponde. Mantiene el id de cada transacción
 * (los gastos compartidos apuntan a él).
 */
export const rebuildCardInstallmentsAdmin = async (
  uid: string,
  account: ServerAccount,
): Promise<number> => {
  if (account.type !== "credit") return 0;
  const db = adminDb();
  const txs = await db
    .collection(`users/${uid}/transactions`)
    .where("accountId", "==", account.id)
    .get();
  let rebuilt = 0;
  for (const txDoc of txs.docs) {
    const tx = txDoc.data();
    // Gastos y reintegros siguen el ciclo de la tarjeta (las transferencias no).
    if (tx.kind !== "expense" && tx.kind !== "income") continue;
    const purchaseDate = (tx.purchaseDate as Timestamp).toDate();
    const installmentsCount = tx.kind === "income" ? 1 : Math.max(1, Number(tx.installments ?? 1));
    const first = computeFirstBillingMonth(
      account,
      purchaseDate,
      Boolean(tx.cardClosedAtPurchase),
    );
    const oldIns = await db
      .collection(`users/${uid}/installments`)
      .where("transactionId", "==", txDoc.id)
      .get();
    const batch = db.batch();
    oldIns.docs.forEach((d) => batch.delete(d.ref));
    batch.update(txDoc.ref, { firstBillingMonth: monthKey(first.year, first.month) });
    await writeInstallments(batch, uid, account, {
      transactionId: txDoc.id,
      accountId: account.id,
      categoryId: String(tx.categoryId),
      description: String(tx.description ?? ""),
      kind: String(tx.kind),
      purchaseDate,
      firstYear: first.year,
      firstMonth: first.month,
      installmentsCount,
      amountPerInstallment: Math.round((Number(tx.totalAmount) / installmentsCount) * 100) / 100,
      isCredit: true,
      currency: (tx.currency as Currency | undefined) ?? "ARS",
      recurringId: tx.recurringId as string | undefined,
      createdByName: tx.createdByName as string | undefined,
      projected: tx.projected === true,
    });
    await batch.commit();
    rebuilt += 1;
  }
  return rebuilt;
};

export interface ServerTransferInput {
  ownerUid: string;
  fromAccountId: string;
  toAccountId: string;
  /** Monto que sale, en `currency`. */
  amount: number;
  currency: Currency;
  /** Monto que entra, en `toCurrency` (en un cambio de moneda difiere). */
  toAmount?: number;
  toCurrency?: Currency;
  rate?: number;
  date: Date;
  description: string;
  transferType: TransferType;
}

/**
 * Transferencia entre cuentas, cambio de moneda (puede ser dentro de la
 * misma cuenta) o pago de tarjeta. Mismo formato que la web
 * (createTransactionWithInstallments): una transacción y dos patas.
 */
export const createTransferAdmin = async (input: ServerTransferInput): Promise<string> => {
  const db = adminDb();
  const toCurrency = input.toCurrency ?? input.currency;
  const toAmount = input.toAmount ?? input.amount;
  if (input.fromAccountId === input.toAccountId && toCurrency === input.currency) {
    throw new Error("No se puede transferir a la misma cuenta en la misma moneda");
  }
  const billingMonth = monthKey(input.date.getFullYear(), input.date.getMonth() + 1);
  const txRef = db.collection(`users/${input.ownerUid}/transactions`).doc();
  const insCol = db.collection(`users/${input.ownerUid}/installments`);
  const isExchange = toCurrency !== input.currency;

  const batch = db.batch();
  batch.set(txRef, {
    accountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    categoryId: "",
    description: input.description,
    totalAmount: input.amount,
    purchaseDate: Timestamp.fromDate(input.date),
    kind: "transfer",
    installments: 1,
    firstBillingMonth: billingMonth,
    currency: input.currency,
    transferType: input.transferType,
    ...(isExchange
      ? { toCurrency, toAmount, ...(input.rate ? { rate: input.rate } : {}) }
      : {}),
    createdAt: FieldValue.serverTimestamp(),
  });
  const base = {
    transactionId: txRef.id,
    categoryId: "",
    billingMonth,
    billingDate: Timestamp.fromDate(input.date),
    paymentMonth: paymentMonthOf(input.date),
    installmentNumber: 1,
    totalInstallments: 1,
    kind: "transfer",
    description: input.description,
    transferType: input.transferType,
  };
  batch.set(insCol.doc(), {
    ...base,
    accountId: input.fromAccountId,
    amount: input.amount,
    currency: input.currency,
    transferRole: "source",
    transferCounterpartId: input.toAccountId,
  });
  batch.set(insCol.doc(), {
    ...base,
    accountId: input.toAccountId,
    amount: toAmount,
    currency: toCurrency,
    transferRole: "destination",
    transferCounterpartId: input.fromAccountId,
  });
  await batch.commit();
  return txRef.id;
};
