import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { createTransactionAdmin } from "./transactions-admin";
import { applySplitRules } from "./split-rules";
import { loadAccounts, loadCategories, toServerAccount } from "./queries-admin";
import { dateFromYMD } from "./time";
import { zeroMoney, type Currency } from "@/lib/domain/types";
import type { BatchDraft, BatchDraftLine } from "./whatsapp/types";

/**
 * Carga en lote: varios gastos/ingresos leídos de una foto (captura del home
 * banking, foto de una planilla, lista escrita) o de un Excel/CSV.
 */

const DAY_MS = 24 * 3600 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01);

/** Total de la compra: en una cuota k/N, el monto de la cuota por N. */
export const lineTotal = (l: Pick<BatchDraftLine, "amount" | "installmentsTotal">) =>
  l.installmentsTotal && l.installmentsTotal > 1 ? round2(l.amount * l.installmentsTotal) : l.amount;

/**
 * Separa los renglones que ya estaban cargados: misma cuenta, tipo, moneda,
 * cantidad de cuotas y total (±1%), comprados ±5 días de la fecha del renglón.
 * Las suscripciones estimadas no cuentan.
 */
export const splitDuplicates = async (
  uid: string,
  lines: BatchDraftLine[],
): Promise<{ fresh: BatchDraftLine[]; duplicates: BatchDraftLine[] }> => {
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const snaps = await Promise.all(
    accountIds.map((id) =>
      adminDb().collection(`users/${uid}/transactions`).where("accountId", "==", id).get(),
    ),
  );
  const existing = snaps.flatMap((s) =>
    s.docs
      .map((d) => {
        const x = d.data();
        return {
          id: d.id,
          accountId: String(x.accountId),
          kind: String(x.kind),
          currency: String(x.currency ?? "ARS"),
          total: Number(x.totalAmount ?? 0),
          installments: Math.max(1, Number(x.installments ?? 1)),
          bought: (x.purchaseDate as Timestamp | undefined)?.toMillis() ?? null,
          projected: x.projected === true,
        };
      })
      .filter((t) => !t.projected),
  );

  const used = new Set<string>();
  const fresh: BatchDraftLine[] = [];
  const duplicates: BatchDraftLine[] = [];
  for (const line of lines) {
    const n = line.installmentsTotal && line.installmentsTotal > 1 ? line.installmentsTotal : 1;
    const total = lineTotal(line);
    const day = dateFromYMD(line.date).getTime();
    const match = existing.find(
      (t) =>
        !used.has(t.id) &&
        t.accountId === line.accountId &&
        t.kind === line.kind &&
        t.currency === line.currency &&
        t.installments === n &&
        near(t.total, total) &&
        t.bought != null &&
        Math.abs(t.bought - day) <= 5 * DAY_MS,
    );
    if (match) {
      used.add(match.id);
      duplicates.push(line);
    } else {
      fresh.push(line);
    }
  }
  return { fresh, duplicates };
};

export interface BatchSaveResult {
  created: number;
  /** Renglones que no se pudieron cargar (cuenta o categoría borrada). */
  failed: string[];
  totals: Record<Currency, number>;
  /** Tarjetas usadas que todavía no tienen días de cierre/vencimiento. */
  cardsPendingDates: string[];
  /** Gastos que se dividieron solos ("dividir siempre"). */
  splitApplied: Array<{ label: string; names: string[] }>;
}

export const saveBatchAdmin = async (uid: string, draft: BatchDraft): Promise<BatchSaveResult> => {
  // Revalidamos: una cuenta o categoría pudo borrarse mientras tanto.
  const [accounts, categories] = await Promise.all([loadAccounts(uid), loadCategories(uid)]);
  const accById = new Map(accounts.filter((a) => a.active).map((a) => [a.id, a]));
  const catById = new Map(categories.map((c) => [c.id, c]));

  const result: BatchSaveResult = { created: 0, failed: [], totals: zeroMoney(), cardsPendingDates: [], splitApplied: [] };
  const ids: string[] = [];
  const pending = new Set<string>();
  for (const line of draft.lines) {
    const account = accById.get(line.accountId);
    const category = catById.get(line.categoryId);
    // En una tarjeta, los reintegros usan categorías de gasto.
    const okKind = category && (category.kind === line.kind || (account?.type === "credit" && category.kind === "expense"));
    if (!account || !category || !okKind || !account.currencies.includes(line.currency)) {
      result.failed.push(line.description);
      continue;
    }
    const isCreditExpense = account.type === "credit" && line.kind === "expense";
    const n = isCreditExpense && line.installmentsTotal && line.installmentsTotal > 1 ? line.installmentsTotal : 1;
    const txId = await createTransactionAdmin({
      ownerUid: uid,
      account: toServerAccount(account),
      accountId: account.id,
      categoryId: category.id,
      description: line.description,
      totalAmount: n > 1 ? lineTotal(line) : line.amount,
      purchaseDate: dateFromYMD(line.date),
      kind: line.kind,
      installments: n,
      currency: line.currency,
    });
    result.created += 1;
    ids.push(txId);
    result.totals[line.currency] = round2(result.totals[line.currency] + (line.kind === "expense" ? line.amount : -line.amount));
    if (account.type === "credit" && (!account.defaultClosingDay || !account.defaultDueDay)) pending.add(account.name);
  }
  result.cardsPendingDates = [...pending];
  result.splitApplied = (await applySplitRules(uid, ids)).map(({ label, names }) => ({ label, names }));
  return result;
};
