import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { PeopleError } from "./connections";
import {
  activeSplitIdsForTx,
  cancelSplit,
  checkSplitParticipants,
  createSplit,
  relinkSplit,
  type AutoAccept,
  type ParticipantInput,
} from "./splits";
import { currentMonthKey } from "./time";
import { normalizeMerchant } from "@/lib/domain/merchants";
import { isPersonAccountId, type SplitMode } from "@/lib/domain/people";

/**
 * "Dividir siempre": reglas por comercio/servicio (users/{uid}/splitRules).
 * Cada gasto nuevo con ese nombre (cargado en la app, por el bot, desde un
 * resumen o estimado) se divide solo con las mismas personas y partes. A los
 * que usan la app les llega para aceptar, como siempre.
 */

export interface SplitRule {
  id: string;
  /** Comercio normalizado (normalizeMerchant). */
  key: string;
  /** Cómo se muestra ("Federación Patronal Seguros"). */
  label: string;
  participants: Array<ParticipantInput & { name: string }>;
  mode: SplitMode;
  /** Los que aceptan siempre: uid → si lo suman a sus gastos y con qué categoría. */
  autoAccept?: AutoAccept;
  createdAt?: Timestamp;
}

const rulesCol = (uid: string) => adminDb().collection(`users/${uid}/splitRules`);

export const loadSplitRules = async (uid: string): Promise<SplitRule[]> =>
  (await rulesCol(uid).get()).docs.map((d) => ({ id: d.id, ...d.data() }) as SplitRule);

/**
 * Divide los gastos que coinciden con una regla y todavía no están divididos.
 * Devuelve los que se dividieron (para contarle al usuario).
 */
export const applySplitRules = async (
  uid: string,
  txIds: string[],
  rules?: SplitRule[],
): Promise<Array<{ txId: string; splitId: string; label: string; names: string[] }>> => {
  const list = rules ?? (await loadSplitRules(uid));
  if (list.length === 0 || txIds.length === 0) return [];
  const out: Array<{ txId: string; splitId: string; label: string; names: string[] }> = [];
  for (const txId of txIds) {
    const tx = (await adminDb().doc(`users/${uid}/transactions/${txId}`).get()).data();
    if (!tx || tx.kind !== "expense" || isPersonAccountId(tx.accountId as string)) continue;
    const key = normalizeMerchant(String(tx.description ?? ""));
    let rule = list.find((r) => r.key === key);
    // Un fijo aplicado se llama como el fijo ("Sancor Salud"), pero la regla
    // puede estar por cómo figura en el resumen ("asoc mutual").
    if (!rule && tx.recurringId) {
      const rec = (await adminDb().doc(`users/${uid}/recurring/${tx.recurringId}`).get()).data();
      const matchKey = typeof rec?.matchKey === "string" ? rec.matchKey : "";
      if (matchKey) rule = list.find((r) => r.key === matchKey);
    }
    if (!rule) continue;
    if ((await activeSplitIdsForTx(uid, txId)).length > 0) continue;
    try {
      const splitId = await createSplit(
        { uid },
        {
          txId,
          mode: rule.mode,
          participants: rule.participants.map(({ ref, shareType, value }) => ({ ref, shareType, value })),
          ruleId: rule.id,
          autoAccept: rule.autoAccept,
        },
      );
      out.push({ txId, splitId, label: rule.label, names: rule.participants.map((p) => p.name) });
    } catch (err) {
      // Ej. ya no están conectados o el monto no alcanza para la parte fija: se deja sin dividir.
      console.warn("[split-rules] no se aplicó", uid, txId, err instanceof Error ? err.message : err);
    }
  }
  return out;
};

/**
 * Crea (o reemplaza) la regla para el comercio de un gasto, y la aplica a los
 * gastos ya cargados de ese comercio desde este mes que no estén divididos.
 */
export const createSplitRule = async (
  uid: string,
  input: { txId: string; mode: SplitMode; participants: ParticipantInput[] },
): Promise<{ id: string; label: string; applied: number }> => {
  const { tx, participants } = await checkSplitParticipants(uid, input.txId, input.participants);
  const key = normalizeMerchant(tx.description);
  if (!key) throw new PeopleError("Ese gasto no tiene un nombre para reconocerlo");
  const existing = (await rulesCol(uid).where("key", "==", key).get()).docs[0];
  const ref = existing?.ref ?? rulesCol(uid).doc();
  // Si ya existía: los que aceptaban siempre lo siguen haciendo solo si su parte no cambió.
  const prev = existing ? ({ id: existing.id, ...existing.data() } as SplitRule) : null;
  const autoAccept: AutoAccept = {};
  for (const [puid, a] of Object.entries(prev?.autoAccept ?? {})) {
    const before = prev!.participants.find((p) => p.ref === `u:${puid}`);
    const now = input.participants.find((p) => p.ref === `u:${puid}`);
    if (before && now && before.shareType === now.shareType && before.value === now.value) autoAccept[puid] = a;
  }
  const rule: Omit<SplitRule, "id"> = {
    key,
    label: tx.description,
    participants: participants.map((p, i) => ({
      ref: p.ref,
      shareType: input.participants[i].shareType,
      value: input.participants[i].value,
      name: p.name,
    })),
    mode: input.mode,
    autoAccept,
  };
  await ref.set({ ...rule, createdAt: FieldValue.serverTimestamp() });
  // El reparto del gasto de ejemplo también queda atado a la regla (para "aceptar siempre").
  for (const splitId of await activeSplitIdsForTx(uid, input.txId)) {
    await adminDb().doc(`splits/${splitId}`).update({ ruleId: ref.id });
  }

  // Gastos ya cargados de ese comercio (de este mes en adelante) sin dividir.
  const from = currentMonthKey();
  const txs = await adminDb().collection(`users/${uid}/transactions`).get();
  const ids = txs.docs
    .filter((d) => {
      const t = d.data();
      return (
        t.kind === "expense" &&
        String(t.firstBillingMonth ?? "") >= from &&
        normalizeMerchant(String(t.description ?? "")) === key
      );
    })
    .map((d) => d.id);
  const applied = await applySplitRules(uid, ids, [{ id: ref.id, ...rule }]);
  return { id: ref.id, label: tx.description, applied: applied.length };
};

export const deleteSplitRule = async (uid: string, id: string) => {
  await rulesCol(uid).doc(id).delete();
};

// === Estimados que se reemplazan ===

export interface RemovedProjected {
  txId: string;
  description: string;
  currency: string;
  firstBillingMonth: string;
  amount: number;
  splitIds: string[];
}

/**
 * Después de importar un resumen: los repartos que estaban en estimados
 * borrados pasan al gasto nuevo equivalente (mismo comercio, moneda y
 * resumen; el de monto más parecido). Si no aparece, se cancela.
 * Devuelve los ids de gastos nuevos que quedaron con reparto.
 */
export const relinkProjectedSplits = async (
  uid: string,
  removed: RemovedProjected[],
  newTxIds: string[],
): Promise<Set<string>> => {
  const used = new Set<string>();
  const withSplits = removed.filter((r) => r.splitIds.length > 0);
  if (withSplits.length === 0) return used;
  const candidates = (
    await Promise.all(
      newTxIds.map(async (id) => {
        const t = (await adminDb().doc(`users/${uid}/transactions/${id}`).get()).data();
        return t
          ? {
              id,
              key: normalizeMerchant(String(t.description ?? "")),
              currency: String(t.currency ?? "ARS"),
              month: String(t.firstBillingMonth ?? ""),
              amount: Number(t.totalAmount ?? 0),
              kind: String(t.kind),
            }
          : null;
      }),
    )
  ).filter((c): c is NonNullable<typeof c> => !!c && c.kind === "expense");
  for (const r of withSplits) {
    const key = normalizeMerchant(r.description);
    const match = candidates
      .filter((c) => !used.has(c.id) && c.key === key && c.currency === r.currency && c.month === r.firstBillingMonth)
      .sort((a, b) => Math.abs(a.amount - r.amount) - Math.abs(b.amount - r.amount))[0];
    for (const splitId of r.splitIds) {
      if (match) await relinkSplit(uid, splitId, match.id);
      else await cancelSplit({ uid }, splitId).catch(() => {});
    }
    if (match) used.add(match.id);
  }
  return used;
};
