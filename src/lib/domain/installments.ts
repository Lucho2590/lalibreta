import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Account, Currency, Installment, Transaction, TransferType } from "./types";
import { paymentMonthOf } from "./types";
import { monthKey } from "./types";
import { addMonths, computeFirstBillingMonth, getOrBuildCycle } from "./cycles";

export const installmentsCollectionPath = (uid: string): string =>
  `users/${uid}/installments`;

export const transactionsCollectionPath = (uid: string): string =>
  `users/${uid}/transactions`;

export interface CreateTransactionInput {
  accountId: string;
  categoryId: string;
  description: string;
  totalAmount: number;
  purchaseDate: Date;
  kind: "expense" | "income" | "transfer";
  installments: number;
  cardClosedAtPurchase?: boolean;
  recurringId?: string;
  toAccountId?: string; // requerido si kind === "transfer"
  /** Moneda de totalAmount. Default ARS. */
  currency?: Currency;
  /** Transferencias: tipo y, para cambios de moneda, destino y cotización. */
  transferType?: TransferType;
  toCurrency?: Currency;
  toAmount?: number;
  rate?: number;
}

export const createTransactionWithInstallments = async (
  uid: string,
  account: Account,
  input: CreateTransactionInput,
): Promise<string> => {
  // === Transferencias entre cuentas: 2 installments en el mismo mes ===
  if (input.kind === "transfer") {
    if (!input.toAccountId) {
      throw new Error("Falta toAccountId para una transferencia");
    }
    const currency = input.currency ?? "ARS";
    const toCurrency = input.toCurrency ?? currency;
    const toAmount = input.toAmount ?? input.totalAmount;
    // En la misma cuenta solo tiene sentido un cambio de moneda (USD → ARS).
    if (input.toAccountId === input.accountId && toCurrency === currency) {
      throw new Error("No se puede transferir a la misma cuenta");
    }
    const transferType: TransferType =
      input.transferType ?? (toCurrency !== currency ? "exchange" : "transfer");
    const txRef = doc(collection(db, transactionsCollectionPath(uid)));
    const sourceRef = doc(collection(db, installmentsCollectionPath(uid)));
    const destRef = doc(collection(db, installmentsCollectionPath(uid)));
    const year = input.purchaseDate.getFullYear();
    const month = input.purchaseDate.getMonth() + 1;
    const billingMonth = monthKey(year, month);

    const batch = writeBatch(db);

    const transaction: Omit<Transaction, "id"> = {
      accountId: input.accountId,
      toAccountId: input.toAccountId,
      categoryId: "",
      description: input.description,
      totalAmount: input.totalAmount,
      purchaseDate: Timestamp.fromDate(input.purchaseDate),
      kind: "transfer",
      installments: 1,
      firstBillingMonth: billingMonth,
      currency,
      transferType,
      ...(toCurrency !== currency
        ? { toCurrency, toAmount, ...(input.rate ? { rate: input.rate } : {}) }
        : {}),
      createdAt: Timestamp.now(),
    };
    batch.set(txRef, transaction);

    const baseInstallment = {
      transactionId: txRef.id,
      categoryId: "",
      amount: input.totalAmount,
      billingMonth,
      billingDate: Timestamp.fromDate(input.purchaseDate),
      paymentMonth: paymentMonthOf(input.purchaseDate),
      installmentNumber: 1,
      totalInstallments: 1,
      kind: "transfer" as const,
      description: input.description,
      transferType,
    };
    // Cada pata lleva su moneda y su monto (en un cambio difieren).
    batch.set(sourceRef, {
      ...baseInstallment,
      accountId: input.accountId,
      currency,
      transferRole: "source",
      transferCounterpartId: input.toAccountId,
    });
    batch.set(destRef, {
      ...baseInstallment,
      amount: toAmount,
      accountId: input.toAccountId,
      currency: toCurrency,
      transferRole: "destination",
      transferCounterpartId: input.accountId,
    });

    await batch.commit();
    return txRef.id;
  }

  // === Gastos / Ingresos (con cuotas para crédito) ===
  const isCredit = account.type === "credit" && input.kind === "expense";
  // En una tarjeta, gastos Y reintegros van al resumen (mes del cierre y fecha
  // de vencimiento). Las cuotas son solo para gastos.
  const followsCardCycle = account.type === "credit";
  const installmentsCount = isCredit ? Math.max(1, input.installments) : 1;
  const amountPerInstallment =
    Math.round((input.totalAmount / installmentsCount) * 100) / 100;

  const txRef = doc(collection(db, transactionsCollectionPath(uid)));
  const installmentRefs = Array.from({ length: installmentsCount }, () =>
    doc(collection(db, installmentsCollectionPath(uid))),
  );

  let firstYear: number;
  let firstMonth: number;
  if (followsCardCycle) {
    const first = computeFirstBillingMonth(
      account,
      input.purchaseDate,
      input.cardClosedAtPurchase ?? false,
    );
    firstYear = first.year;
    firstMonth = first.month;
  } else {
    firstYear = input.purchaseDate.getFullYear();
    firstMonth = input.purchaseDate.getMonth() + 1;
  }

  const batch = writeBatch(db);

  const transaction: Omit<Transaction, "id"> = {
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
    createdAt: Timestamp.now(),
  };
  batch.set(txRef, transaction);

  for (let i = 0; i < installmentsCount; i += 1) {
    const { year, month } = addMonths(firstYear, firstMonth, i);
    let billingDate: Date;
    if (followsCardCycle) {
      const cycle = await getOrBuildCycle(uid, account, year, month);
      billingDate = cycle.dueDate.toDate();
    } else {
      billingDate = input.purchaseDate;
    }
    const installment: Omit<Installment, "id"> = {
      transactionId: txRef.id,
      accountId: input.accountId,
      categoryId: input.categoryId,
      amount: amountPerInstallment,
      billingMonth: monthKey(year, month),
      billingDate: Timestamp.fromDate(billingDate),
      paymentMonth: paymentMonthOf(billingDate),
      installmentNumber: i + 1,
      totalInstallments: installmentsCount,
      kind: input.kind,
      description: input.description,
      currency: input.currency ?? "ARS",
      ...(input.recurringId ? { recurringId: input.recurringId } : {}),
      // Plata que "entra" a una tarjeta = saldo a favor, no ingreso.
      ...(followsCardCycle && input.kind === "income" ? { cardCredit: true } : {}),
    };
    batch.set(installmentRefs[i], installment);
  }

  await batch.commit();
  return txRef.id;
};

export const deleteTransactionAndInstallments = async (
  uid: string,
  transactionId: string,
): Promise<void> => {
  const installmentsQuery = query(
    collection(db, installmentsCollectionPath(uid)),
    where("transactionId", "==", transactionId),
  );
  const snap = await getDocs(installmentsQuery);
  const batch = writeBatch(db);
  snap.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, `${transactionsCollectionPath(uid)}/${transactionId}`));
  await batch.commit();
};

export const regenerateFutureInstallmentsForAccount = async (
  uid: string,
  account: Account,
  fromMonthKey: string,
): Promise<void> => {
  const txSnap = await getDocs(
    query(
      collection(db, transactionsCollectionPath(uid)),
      where("accountId", "==", account.id),
    ),
  );
  for (const txDoc of txSnap.docs) {
    const tx = { id: txDoc.id, ...(txDoc.data() as Omit<Transaction, "id">) };
    if (!tx.firstBillingMonth) continue;
    if (tx.firstBillingMonth >= fromMonthKey) {
      await deleteTransactionAndInstallments(uid, tx.id);
      await createTransactionWithInstallments(uid, account, {
        accountId: tx.accountId,
        categoryId: tx.categoryId,
        description: tx.description,
        totalAmount: tx.totalAmount,
        purchaseDate: tx.purchaseDate.toDate(),
        kind: tx.kind,
        installments: tx.installments,
        cardClosedAtPurchase: tx.cardClosedAtPurchase ?? false,
        currency: tx.currency,
        ...(tx.recurringId ? { recurringId: tx.recurringId } : {}),
        ...(tx.kind === "transfer"
          ? {
              toAccountId: tx.toAccountId,
              transferType: tx.transferType,
              toCurrency: tx.toCurrency,
              toAmount: tx.toAmount,
              rate: tx.rate,
            }
          : {}),
      });
      continue;
    }

    const installmentsSnap = await getDocs(
      query(
        collection(db, installmentsCollectionPath(uid)),
        where("transactionId", "==", tx.id),
        where("billingMonth", ">=", fromMonthKey),
      ),
    );
    if (installmentsSnap.empty) continue;
    const batch = writeBatch(db);
    for (const insDoc of installmentsSnap.docs) {
      const ins = insDoc.data() as Omit<Installment, "id">;
      const [y, m] = ins.billingMonth.split("-").map(Number);
      const cycle = await getOrBuildCycle(uid, account, y, m);
      batch.update(insDoc.ref, {
        billingDate: cycle.dueDate,
        paymentMonth: paymentMonthOf(cycle.dueDate.toDate()),
      });
    }
    await batch.commit();
  }
  void deleteDoc;
};
