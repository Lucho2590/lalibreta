import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import { PeopleError, getConnection, loadProfile } from "./connections";
import { dateFromYMD } from "./time";
import {
  computeShares,
  parsePersonRef,
  participantSchedule,
  personAccountId,
  profileName,
  userRef,
  type PersonRef,
  type Split,
  type SplitMode,
  type SplitParticipant,
  type SplitScheduleEntry,
} from "@/lib/domain/people";
import type { Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

/**
 * Gastos repartidos (splits/{id}). Yo pago un gasto con una cuenta/tarjeta
 * mía y le asigno una parte (% o monto) a otras personas:
 * - Con la app (conectados): la tienen que aceptar. Al aceptar eligen si la
 *   suman a sus gastos (asiento en sus cuentas contra "person:u:<yo>", que
 *   cuenta en su balance del mes pero no en el saldo de sus cuentas).
 * - Sin la app (contactos): quedan "offline" y me lo deben hasta que me pagan.
 * El cliente solo lee: todo se escribe acá.
 */

/** Algo donde escribir docs: una transacción o un batch. */
type DocWriter = { set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): unknown };

const col = () => adminDb().collection("splits");
const ymdAR = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

export interface ParticipantInput {
  ref: PersonRef;
  shareType: "percent" | "amount";
  value: number;
}

const toSplit = (snap: FirebaseFirestore.DocumentSnapshot): Split => ({ id: snap.id, ...snap.data() }) as Split;

/** Gasto del dueño y sus cuotas (montos, moneda y meses salen de acá, no del cliente). */
const loadOwnerExpense = async (ownerUid: string, txId: string) => {
  const db = adminDb();
  const txSnap = await db.doc(`users/${ownerUid}/transactions/${txId}`).get();
  if (!txSnap.exists) throw new PeopleError("El gasto ya no existe", 404);
  const tx = txSnap.data()!;
  if (tx.kind !== "expense") throw new PeopleError("Solo se pueden repartir gastos");
  const ins = await db.collection(`users/${ownerUid}/installments`).where("transactionId", "==", txId).get();
  const schedule: SplitScheduleEntry[] = ins.docs
    .map((d) => d.data())
    .sort((a, b) => Number(a.installmentNumber ?? 1) - Number(b.installmentNumber ?? 1))
    .map((i) => {
      const date = (i.billingDate as Timestamp).toDate();
      return {
        paymentMonth: String(i.paymentMonth ?? i.billingMonth),
        date: ymdAR.format(date),
        amount: Number(i.amount ?? 0),
      };
    });
  const acc = (await db.doc(`users/${ownerUid}/accounts/${tx.accountId}`).get()).data();
  return {
    totalAmount: Number(tx.totalAmount ?? 0),
    currency: ((tx.currency as Currency | undefined) ?? "ARS") as Currency,
    description: String(tx.description ?? ""),
    date: ymdAR.format((tx.purchaseDate as Timestamp).toDate()),
    installments: Math.max(1, Number(tx.installments ?? 1)),
    accountName: (acc?.name as string | undefined) ?? null,
    schedule,
  };
};

/** Arma cada participante: valida conexión (usuarios) o que exista el contacto (sin app). */
const buildParticipants = async (
  ownerUid: string,
  total: number,
  inputs: ParticipantInput[],
  previous: SplitParticipant[] = [],
): Promise<SplitParticipant[]> => {
  if (inputs.length === 0) throw new PeopleError("Elegí con quién repartirlo");
  const refs = new Set<string>();
  for (const i of inputs) {
    if (refs.has(i.ref)) throw new PeopleError("Hay una persona repetida");
    refs.add(i.ref);
  }
  const { amounts, error } = computeShares(total, inputs.map((i) => ({ shareType: i.shareType, value: i.value })));
  if (error) throw new PeopleError(error);
  const out: SplitParticipant[] = [];
  for (const [idx, input] of inputs.entries()) {
    const parsed = parsePersonRef(input.ref);
    if (!parsed) throw new PeopleError("Persona inválida");
    const prev = previous.find((p) => p.ref === input.ref);
    const base = {
      ref: input.ref,
      shareType: input.shareType,
      percent: input.shareType === "percent" ? input.value : null,
      amount: amounts[idx],
      respondedAt: null,
      rejectReason: null,
      addToBooks: false,
      categoryId: null,
      participantTxId: null,
    };
    if (parsed.type === "user") {
      if (parsed.uid === ownerUid) throw new PeopleError("No te podés asignar una parte a vos mismo");
      const c = await getConnection(ownerUid, parsed.uid);
      const profile = c?.profiles?.[parsed.uid] ?? (await loadProfile(parsed.uid));
      if (c?.status !== "accepted") {
        throw new PeopleError(`No estás conectado con ${profileName(profile)}: mandale una solicitud desde Contactos.`);
      }
      // Si ya había aceptado y no cambió su parte, queda como estaba.
      if (prev?.status === "accepted" && Math.abs(prev.amount - amounts[idx]) < 0.01) {
        out.push(prev);
        continue;
      }
      if (prev?.status === "accepted") {
        throw new PeopleError(`${prev.name} ya aceptó su parte: para cambiarla, cancelá el reparto y armalo de nuevo.`);
      }
      out.push({
        ...base,
        uid: parsed.uid,
        contactId: null,
        name: profileName(profile),
        email: profile.email || null,
        status: "pending",
      });
    } else {
      const contact = (await adminDb().doc(`users/${ownerUid}/contacts/${parsed.contactId}`).get()).data();
      if (!contact) throw new PeopleError("Ese contacto ya no existe");
      out.push({
        ...base,
        uid: null,
        contactId: parsed.contactId,
        name: String(contact.displayName || contact.email || "Contacto"),
        email: (contact.email as string | null | undefined) ?? null,
        status: "offline",
      });
    }
  }
  // Los que ya habían aceptado no se pueden sacar.
  for (const p of previous) {
    if (p.status === "accepted" && !out.some((o) => o.ref === p.ref)) {
      throw new PeopleError(`${p.name} ya aceptó su parte: no se la podés sacar (cancelá el reparto).`);
    }
  }
  return out;
};

const indexUids = (ownerUid: string, participants: SplitParticipant[]) => [
  ownerUid,
  ...participants.map((p) => p.uid).filter((u): u is string => !!u && u !== ownerUid),
];

const shareText = (s: Pick<Split, "currency" | "mode" | "installments" | "schedule" | "totalAmount">, amount: number) => {
  const sched = participantSchedule(s, amount);
  return sched.length > 1
    ? `${formatMoney(amount, s.currency)} en ${sched.length} cuotas`
    : formatMoney(amount, s.currency);
};

const askToAccept = async (s: Split, p: SplitParticipant) => {
  if (!p.uid) return;
  await notify(p.uid, {
    kind: "split-request",
    title: `${s.ownerName} te asignó parte de un gasto`,
    body: `${s.description}: te toca ${shareText(s, p.amount)}. Entrá para aceptarlo.`,
    url: `/compartidas/gasto/${s.id}`,
    whatsappText: `💸 *${s.ownerName}* te asignó parte de un gasto: *${s.description}*, te toca *${shareText(s, p.amount)}*. Decime "aceptá el gasto de ${s.ownerName}" o entrá a la app.`,
    dedupeKey: `split-request-${s.id}-${p.uid}-${Date.now()}`,
  });
};

/** Reparte un gasto mío ya cargado. */
export const createSplit = async (
  owner: { uid: string },
  input: { txId: string; mode: SplitMode; participants: ParticipantInput[] },
): Promise<string> => {
  const existing = await col().where("ownerTxId", "==", input.txId).get();
  if (existing.docs.some((d) => d.data().ownerUid === owner.uid && d.data().status === "active")) {
    throw new PeopleError("Ese gasto ya está repartido: editá el reparto que tiene.");
  }
  const tx = await loadOwnerExpense(owner.uid, input.txId);
  if (!(tx.totalAmount > 0)) throw new PeopleError("El gasto no tiene monto");
  const participants = await buildParticipants(owner.uid, tx.totalAmount, input.participants);
  const profile = await loadProfile(owner.uid);
  const ref = col().doc();
  const split: Omit<Split, "id"> = {
    ownerUid: owner.uid,
    ownerName: profileName(profile),
    ownerEmail: profile.email || null,
    ownerTxId: input.txId,
    ownerAccountName: tx.accountName,
    description: tx.description || "Gasto",
    date: tx.date,
    currency: tx.currency,
    totalAmount: tx.totalAmount,
    installments: tx.installments,
    schedule: tx.schedule,
    mode: tx.schedule.length > 1 ? input.mode : "lump",
    participants,
    uids: indexUids(owner.uid, participants),
    status: "active",
  };
  await ref.set({ ...split, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  const created = { id: ref.id, ...split };
  for (const p of participants) await askToAccept(created, p);
  return ref.id;
};

// === Asiento del participante (su parte, en sus cuentas) ===

const participantTxId = (splitId: string) => `split_${splitId}`;

/** Escribe (o reescribe) la parte de un participante como gasto suyo. */
const writeParticipantBooks = async (
  t: DocWriter,
  uid: string,
  split: Split,
  p: SplitParticipant,
  categoryId: string,
) => {
  const db = adminDb();
  const txId = participantTxId(split.id);
  const sched = participantSchedule(split, p.amount);
  const accountId = personAccountId(userRef(split.ownerUid));
  const description = split.description;
  t.set(db.doc(`users/${uid}/transactions/${txId}`), {
    accountId,
    categoryId,
    description,
    totalAmount: p.amount,
    purchaseDate: Timestamp.fromDate(dateFromYMD(split.date)),
    kind: "expense",
    installments: sched.length,
    cardClosedAtPurchase: false,
    firstBillingMonth: sched[0]?.paymentMonth ?? split.date.slice(0, 7),
    currency: split.currency,
    splitId: split.id,
    createdAt: FieldValue.serverTimestamp(),
  });
  sched.forEach((c, i) => {
    t.set(db.doc(`users/${uid}/installments/${txId}_${i + 1}`), {
      transactionId: txId,
      accountId,
      categoryId,
      amount: c.amount,
      billingMonth: c.paymentMonth,
      billingDate: Timestamp.fromDate(dateFromYMD(c.date)),
      paymentMonth: c.paymentMonth,
      installmentNumber: i + 1,
      totalInstallments: sched.length,
      kind: "expense",
      description,
      currency: split.currency,
      splitId: split.id,
    });
  });
  return txId;
};

/** Borra la parte de un participante de sus cuentas. */
const removeParticipantBooks = async (uid: string, splitId: string) => {
  const db = adminDb();
  const txId = participantTxId(splitId);
  const ins = await db.collection(`users/${uid}/installments`).where("transactionId", "==", txId).get();
  const batch = db.batch();
  ins.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(db.doc(`users/${uid}/transactions/${txId}`));
  await batch.commit();
};

const checkCategory = async (uid: string, categoryId: string | null | undefined) => {
  if (!categoryId) throw new PeopleError("Elegí una categoría para sumarlo a tus gastos");
  const cat = (await adminDb().doc(`users/${uid}/categories/${categoryId}`).get()).data();
  if (!cat || cat.kind !== "expense") throw new PeopleError("Esa categoría no es de gastos");
};

/** El participante acepta (y elige si lo suma a sus gastos) o rechaza. */
export const respondSplit = async (
  user: { uid: string },
  splitId: string,
  input: { accept: boolean; addToBooks?: boolean; categoryId?: string | null; reason?: string | null },
): Promise<void> => {
  if (input.accept && input.addToBooks) await checkCategory(user.uid, input.categoryId);
  const ref = col().doc(splitId);
  const result = await adminDb().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new PeopleError("Ese gasto ya no existe", 404);
    const split = toSplit(snap);
    if (split.status !== "active") throw new PeopleError("El reparto fue cancelado");
    const idx = split.participants.findIndex((p) => p.uid === user.uid);
    if (idx === -1) throw new PeopleError("No participás de este gasto", 403);
    const me = split.participants[idx];
    const next = input.accept ? "accepted" : "rejected";
    if (me.status === next) return null;
    if (me.status !== "pending") throw new PeopleError("Ya lo respondiste");
    const conn = await t.get(adminDb().collection("connections").doc([split.ownerUid, user.uid].sort().join("_")));
    if (conn.data()?.status !== "accepted") throw new PeopleError("Ya no están conectados");
    let txId: string | null = null;
    if (input.accept && input.addToBooks) {
      txId = await writeParticipantBooks(t, user.uid, split, me, input.categoryId!);
    }
    const updated: SplitParticipant = {
      ...me,
      status: next,
      respondedAt: Timestamp.now(),
      rejectReason: input.accept ? null : input.reason?.trim() || null,
      addToBooks: !!txId,
      categoryId: txId ? input.categoryId! : null,
      participantTxId: txId,
    };
    const participants = split.participants.map((p, i) => (i === idx ? updated : p));
    t.update(ref, { participants, updatedAt: FieldValue.serverTimestamp() });
    return { split, me: updated };
  });
  if (!result) return;
  const { split, me } = result;
  const accepted = me.status === "accepted";
  await notify(split.ownerUid, {
    kind: "split-response",
    title: accepted ? `${me.name} aceptó su parte` : `${me.name} no aceptó su parte`,
    body: accepted
      ? `${split.description}: ${shareText(split, me.amount)}. Ya cuenta como plata que te debe.`
      : `${split.description}${me.rejectReason ? `: "${me.rejectReason}"` : ""}. Podés cambiar el reparto o cancelarlo.`,
    url: `/compartidas/gasto/${split.id}`,
    whatsappText: accepted
      ? `✅ *${me.name}* aceptó su parte de *${split.description}* (${shareText(split, me.amount)}).`
      : `❌ *${me.name}* no aceptó su parte de *${split.description}*${me.rejectReason ? `: "${me.rejectReason}"` : ""}.`,
    dedupeKey: `split-response-${split.id}-${user.uid}-${Date.now()}`,
  });
};

/** El participante (ya aceptado) suma o saca su parte de sus gastos. */
export const setSplitBooks = async (
  user: { uid: string },
  splitId: string,
  input: { addToBooks: boolean; categoryId?: string | null },
): Promise<void> => {
  if (input.addToBooks) await checkCategory(user.uid, input.categoryId);
  else await removeParticipantBooks(user.uid, splitId);
  const ref = col().doc(splitId);
  await adminDb().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new PeopleError("Ese gasto ya no existe", 404);
    const split = toSplit(snap);
    const idx = split.participants.findIndex((p) => p.uid === user.uid);
    if (idx === -1) throw new PeopleError("No participás de este gasto", 403);
    const me = split.participants[idx];
    if (me.status !== "accepted") throw new PeopleError("Primero aceptá tu parte");
    let txId: string | null = null;
    if (input.addToBooks) txId = await writeParticipantBooks(t, user.uid, split, me, input.categoryId!);
    const participants = split.participants.map((p, i) =>
      i === idx ? { ...p, addToBooks: !!txId, categoryId: txId ? input.categoryId! : null, participantTxId: txId } : p,
    );
    t.update(ref, { participants, updatedAt: FieldValue.serverTimestamp() });
  });
};

/** El dueño cambia el reparto (solo lo que todavía no aceptaron). */
export const updateSplit = async (
  owner: { uid: string },
  splitId: string,
  input: { mode?: SplitMode; participants: ParticipantInput[] },
): Promise<void> => {
  const ref = col().doc(splitId);
  const snap = await ref.get();
  if (!snap.exists) throw new PeopleError("Ese gasto ya no existe", 404);
  const split = toSplit(snap);
  if (split.ownerUid !== owner.uid) throw new PeopleError("Solo lo puede cambiar quien lo cargó", 403);
  if (split.status !== "active") throw new PeopleError("El reparto fue cancelado");
  const hasAccepted = split.participants.some((p) => p.status === "accepted");
  if (input.mode && input.mode !== split.mode && hasAccepted) {
    throw new PeopleError("Ya hay alguien que aceptó: no se puede cambiar cómo te lo pagan.");
  }
  const participants = await buildParticipants(owner.uid, split.totalAmount, input.participants, split.participants);
  const updated: Split = {
    ...split,
    mode: input.mode && split.schedule.length > 1 ? input.mode : split.mode,
    participants,
    uids: indexUids(owner.uid, participants),
  };
  await ref.update({
    mode: updated.mode,
    participants,
    uids: updated.uids,
    updatedAt: FieldValue.serverTimestamp(),
  });
  // A los que les cambió la parte (o se sumaron) se les vuelve a pedir.
  for (const p of participants) {
    const prev = split.participants.find((x) => x.ref === p.ref);
    if (p.status === "pending" && (!prev || prev.status !== "pending" || Math.abs(prev.amount - p.amount) >= 0.01)) {
      await askToAccept(updated, p);
    }
  }
};

/** El dueño cancela el reparto (y, si quiere, borra el gasto). */
export const cancelSplit = async (
  owner: { uid: string },
  splitId: string,
  opts: { deleteOwnerTx?: boolean } = {},
): Promise<void> => {
  const ref = col().doc(splitId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const split = toSplit(snap);
  if (split.ownerUid !== owner.uid) throw new PeopleError("Solo lo puede cancelar quien lo cargó", 403);
  if (split.status !== "cancelled") {
    await ref.update({ status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
    for (const p of split.participants) {
      if (!p.uid) continue;
      if (p.participantTxId) await removeParticipantBooks(p.uid, split.id);
      if (p.status === "pending" || p.status === "accepted") {
        await notify(p.uid, {
          kind: "split-cancelled",
          title: `${split.ownerName} canceló un gasto repartido`,
          body: `${split.description}: ya no te toca pagar ${shareText(split, p.amount)}.`,
          url: "/compartidas",
          dedupeKey: `split-cancelled-${split.id}-${p.uid}`,
        });
      }
    }
  }
  if (opts.deleteOwnerTx) {
    const db = adminDb();
    const ins = await db.collection(`users/${owner.uid}/installments`).where("transactionId", "==", split.ownerTxId).get();
    const batch = db.batch();
    ins.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(db.doc(`users/${owner.uid}/transactions/${split.ownerTxId}`));
    await batch.commit();
  }
};

/**
 * Las cuotas del gasto del dueño cambiaron (ej. cambió los días de la
 * tarjeta): se vuelven a copiar los meses y se rehacen los asientos de los
 * participantes.
 */
export const resyncSplitsForTx = async (ownerUid: string, txIds: string[]): Promise<number> => {
  let n = 0;
  for (const txId of txIds) {
    const snaps = await col().where("ownerTxId", "==", txId).get();
    for (const d of snaps.docs) {
      const split = toSplit(d);
      if (split.ownerUid !== ownerUid || split.status !== "active") continue;
      const tx = await loadOwnerExpense(ownerUid, txId).catch(() => null);
      if (!tx) continue;
      const updated: Split = { ...split, schedule: tx.schedule, totalAmount: tx.totalAmount };
      await d.ref.update({ schedule: tx.schedule, totalAmount: tx.totalAmount, updatedAt: FieldValue.serverTimestamp() });
      for (const p of split.participants) {
        if (!p.uid || !p.participantTxId || !p.categoryId) continue;
        await removeParticipantBooks(p.uid, split.id);
        const batch = adminDb().batch();
        await writeParticipantBooks(batch, p.uid, updated, p, p.categoryId);
        await batch.commit();
      }
      n += 1;
    }
  }
  return n;
};

/** Repartos donde participo (como dueño o como participante). */
export const loadSplitsFor = async (uid: string): Promise<Split[]> =>
  (await col().where("uids", "array-contains", uid).get()).docs.map(toSplit);

export const splitShareText = shareText;
