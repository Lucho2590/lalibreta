import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import type { AccountType, Currency } from "@/lib/domain/types";
import { rebuildCardInstallmentsAdmin, type ServerAccount } from "./transactions-admin";

/** Mismo criterio que defaultIconForType (components/account-icon.tsx). */
const DEFAULT_ICON: Record<AccountType, string> = {
  credit: "credit-card",
  debit: "wallet",
  cash: "banknote",
  checking: "landmark",
  savings: "piggy-bank",
  digital: "smartphone",
  reserve: "coins",
};

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  closingDay?: number | null;
  dueDay?: number | null;
  parentId?: string | null;
  last4?: string | null;
  /** Monedas (no aplica a tarjetas). Default ["ARS"]. */
  currencies?: Currency[] | null;
  isMain?: boolean;
  openingBalances?: Partial<Record<Currency, number>> | null;
}

const clampDay = (d: number) => Math.min(31, Math.max(1, Math.round(d)));

/** Crea una cuenta con los mismos campos que el formulario de la web. */
export const createAccountAdmin = async (
  uid: string,
  input: CreateAccountInput,
): Promise<string> => {
  const data: Record<string, unknown> = {
    name: input.name.trim(),
    type: input.type,
    icon: DEFAULT_ICON[input.type],
    active: true,
    createdAt: Timestamp.now(),
  };
  if (input.type === "credit") {
    // Las fechas pueden quedar pendientes (se completan después con
    // setCardDatesAdmin o al leer un resumen).
    if (input.closingDay && input.dueDay) {
      data.defaultClosingDay = clampDay(input.closingDay);
      data.defaultDueDay = clampDay(input.dueDay);
    }
    if (input.parentId) data.parentId = input.parentId;
  }
  if (input.last4) data.last4 = input.last4;
  // Cobacha: vive dentro de otra cuenta y tiene una sola moneda.
  if (input.type === "reserve" && input.parentId) data.parentId = input.parentId;
  if (input.type !== "credit") {
    data.currencies = input.currencies?.length ? input.currencies : ["ARS"];
    const opening = Object.fromEntries(
      Object.entries(input.openingBalances ?? {}).filter(([, v]) => typeof v === "number" && v !== 0),
    );
    if (Object.keys(opening).length > 0) {
      data.openingBalances = opening;
      data.openingDate = Timestamp.now();
    }
  }
  const col = adminDb().collection(`users/${uid}/accounts`);
  const ref = col.doc();
  const batch = adminDb().batch();
  if (input.isMain && input.type !== "credit" && input.type !== "reserve") {
    // Una sola cuenta principal.
    data.isMain = true;
    const others = await col.where("isMain", "==", true).get();
    others.docs.forEach((d) => batch.update(d.ref, { isMain: false }));
  }
  batch.set(ref, data);
  await batch.commit();
  return ref.id;
};

/** Marca una cuenta como principal (y desmarca las demás). */
export const setMainAccountAdmin = async (uid: string, accountId: string) => {
  const col = adminDb().collection(`users/${uid}/accounts`);
  const others = await col.where("isMain", "==", true).get();
  const batch = adminDb().batch();
  others.docs.forEach((d) => {
    if (d.id !== accountId) batch.update(d.ref, { isMain: false });
  });
  batch.update(col.doc(accountId), { isMain: true });
  await batch.commit();
};

export const setAccountLast4 = async (uid: string, accountId: string, last4: string) =>
  adminDb().doc(`users/${uid}/accounts/${accountId}`).update({ last4 });

/**
 * Guarda los días de cierre/vencimiento de una tarjeta. Si estaban
 * pendientes, rearma las cuotas de lo que se cargó mientras tanto.
 */
export const setCardDatesAdmin = async (
  uid: string,
  account: ServerAccount & { defaultClosingDay?: number; defaultDueDay?: number },
  closingDay: number,
  dueDay: number,
): Promise<{ rebuilt: number; wasPending: boolean }> => {
  const wasPending = !account.defaultClosingDay || !account.defaultDueDay;
  const closing = clampDay(closingDay);
  const due = clampDay(dueDay);
  await adminDb()
    .doc(`users/${uid}/accounts/${account.id}`)
    .update({ defaultClosingDay: closing, defaultDueDay: due });
  if (!wasPending) return { rebuilt: 0, wasPending };
  const rebuilt = await rebuildCardInstallmentsAdmin(uid, {
    ...account,
    defaultClosingDay: closing,
    defaultDueDay: due,
  });
  return { rebuilt, wasPending };
};

/**
 * Fija ("set") o suma ("add") saldo en una cuenta que no es tarjeta,
 * ajustando el saldo inicial. Con "set", el saldo actual pasa a ser el
 * indicado (se tiene en cuenta lo ya movido). Agrega la moneda si faltaba.
 */
export const setAccountBalanceAdmin = async (
  uid: string,
  account: {
    id: string;
    currencies: Currency[];
    openingBalances: Partial<Record<Currency, number>> | null;
  },
  current: Record<Currency, number>,
  amounts: Partial<Record<Currency, number>>,
  mode: "set" | "add",
): Promise<Partial<Record<Currency, number>>> => {
  const result: Partial<Record<Currency, number>> = {};
  const patch: Record<string, unknown> = { openingDate: Timestamp.now() };
  const newCurrencies: Currency[] = [];
  for (const [c, value] of Object.entries(amounts) as Array<[Currency, number]>) {
    if (typeof value !== "number") continue;
    const delta = Math.round((mode === "set" ? value - (current[c] ?? 0) : value) * 100) / 100;
    // Incremento atómico por moneda: si el agente manda pesos y dólares en
    // llamadas separadas (en paralelo), no se pisan entre sí.
    patch[`openingBalances.${c}`] = FieldValue.increment(delta);
    if (!account.currencies.includes(c)) newCurrencies.push(c);
    result[c] = Math.round(((current[c] ?? 0) + delta) * 100) / 100;
    current[c] = result[c]!;
  }
  if (newCurrencies.length > 0) patch.currencies = FieldValue.arrayUnion(...newCurrencies);
  await adminDb().doc(`users/${uid}/accounts/${account.id}`).update(patch);
  return result;
};
