import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import { PeopleError, getConnection, loadProfile } from "./connections";
import { dateFromYMD, isYMD, todayYMD } from "./time";
import {
  parsePersonRef,
  personAccountId,
  profileName,
  transferSide,
  userRef,
  type PersonRef,
  type PersonTransfer,
} from "@/lib/domain/people";
import type { Currency } from "@/lib/domain/types";
import { currencyLabel, formatMoney } from "@/lib/format";

/**
 * Plata que le paso a una persona o que me pasa (p2pTransfers/{id}). Sirve
 * para pagar/cobrar lo que se deben y para préstamos. Cada uno registra su
 * lado en sus cuentas (una sola pata, contra "person:<ref>"): no es ingreso
 * ni gasto, solo mueve el saldo de la cuenta.
 * - Con alguien de la app: mi lado se registra al toque; la otra persona
 *   confirma y elige su cuenta. Recién ahí cuenta para lo que se deben.
 * - Con alguien sin la app: queda confirmado al toque.
 */

/** Algo donde escribir docs: una transacción o un batch. */
type DocWriter = { set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): unknown };

const col = () => adminDb().collection("p2pTransfers");
const round2 = (n: number) => Math.round(n * 100) / 100;
const legId = (id: string) => `p2p_${id}`;

const toTransfer = (snap: FirebaseFirestore.DocumentSnapshot): PersonTransfer =>
  ({ id: snap.id, ...snap.data() }) as PersonTransfer;

/** Valida una cuenta mía para mover plata (y le agrega la moneda si no la tenía). */
const checkAccount = async (uid: string, accountId: string, currency: Currency) => {
  const ref = adminDb().doc(`users/${uid}/accounts/${accountId}`);
  const acc = (await ref.get()).data();
  if (!acc || acc.active === false) throw new PeopleError("Esa cuenta no existe");
  if (acc.type === "credit") throw new PeopleError("Elegí una cuenta (no una tarjeta)");
  const currencies = (acc.currencies as Currency[] | undefined)?.length ? (acc.currencies as Currency[]) : ["ARS"];
  if (!currencies.includes(currency)) {
    if (acc.type === "reserve") throw new PeopleError(`"${acc.name}" no maneja ${currencyLabel(currency).toLowerCase()}`);
    await ref.update({ currencies: [...currencies, currency] });
  }
  return String(acc.name ?? "");
};

const writeLeg = (
  t: DocWriter,
  uid: string,
  tr: Omit<PersonTransfer, "id"> & { id: string },
  accountId: string,
) => {
  const db = adminDb();
  const side = transferSide(tr, uid)!;
  const id = legId(tr.id);
  const role = side.direction === "out" ? "source" : "destination";
  const counterpart = personAccountId(side.person);
  const date = dateFromYMD(tr.date);
  const month = tr.date.slice(0, 7);
  t.set(db.doc(`users/${uid}/transactions/${id}`), {
    accountId,
    toAccountId: counterpart,
    categoryId: "",
    description: tr.description,
    totalAmount: tr.amount,
    purchaseDate: Timestamp.fromDate(date),
    kind: "transfer",
    installments: 1,
    firstBillingMonth: month,
    currency: tr.currency,
    transferType: "p2p",
    p2pTransferId: tr.id,
    createdAt: FieldValue.serverTimestamp(),
  });
  t.set(db.doc(`users/${uid}/installments/${id}`), {
    transactionId: id,
    accountId,
    categoryId: "",
    amount: tr.amount,
    billingMonth: month,
    billingDate: Timestamp.fromDate(date),
    paymentMonth: month,
    installmentNumber: 1,
    totalInstallments: 1,
    kind: "transfer",
    description: tr.description,
    transferType: "p2p",
    transferRole: role,
    transferCounterpartId: counterpart,
    currency: tr.currency,
    p2pTransferId: tr.id,
  });
  return id;
};

const deleteLeg = async (uid: string, id: string) => {
  const db = adminDb();
  const batch = db.batch();
  batch.delete(db.doc(`users/${uid}/installments/${legId(id)}`));
  batch.delete(db.doc(`users/${uid}/transactions/${legId(id)}`));
  await batch.commit();
};

export interface PersonTransferInput {
  person: PersonRef;
  /** out = le pasé / le presté; in = me pasó / me pagó. */
  direction: "out" | "in";
  accountId: string;
  amount: number;
  currency: Currency;
  date?: string;
  description?: string;
  kind?: "payment" | "loan";
}

export const createPersonTransfer = async (
  user: { uid: string },
  input: PersonTransferInput,
): Promise<{ id: string; status: "pending" | "accepted"; name: string }> => {
  const amount = round2(input.amount);
  if (!(amount > 0)) throw new PeopleError("Ingresá un monto");
  const date = input.date && isYMD(input.date) ? input.date : todayYMD();
  const parsed = parsePersonRef(input.person);
  if (!parsed) throw new PeopleError("Persona inválida");
  await checkAccount(user.uid, input.accountId, input.currency);

  const me = await loadProfile(user.uid);
  const myName = profileName(me);
  let otherName: string;
  let otherUid: string | null = null;
  if (parsed.type === "user") {
    if (parsed.uid === user.uid) throw new PeopleError("Esa persona sos vos");
    const c = await getConnection(user.uid, parsed.uid);
    if (c?.status !== "accepted") throw new PeopleError("No están conectados: mandale una solicitud desde Contactos.");
    otherName = profileName(c.profiles[parsed.uid]);
    otherUid = parsed.uid;
  } else {
    const contact = (await adminDb().doc(`users/${user.uid}/contacts/${parsed.contactId}`).get()).data();
    if (!contact) throw new PeopleError("Ese contacto ya no existe");
    otherName = String(contact.displayName || contact.email || "Contacto");
  }

  const mine = userRef(user.uid);
  const out = input.direction === "out";
  const kind = input.kind ?? "payment";
  const description =
    input.description?.trim() ||
    (out ? (kind === "loan" ? `Préstamo a ${otherName}` : `Le pasé a ${otherName}`) : `Me pasó ${otherName}`);
  const ref = col().doc();
  const tr: Omit<PersonTransfer, "id"> = {
    uids: otherUid ? [user.uid, otherUid] : [user.uid],
    createdByUid: user.uid,
    from: out ? mine : input.person,
    to: out ? input.person : mine,
    fromName: out ? myName : otherName,
    toName: out ? otherName : myName,
    amount,
    currency: input.currency,
    date,
    description,
    kind,
    status: otherUid ? "pending" : "accepted",
    legs: { [user.uid]: { accountId: input.accountId, txId: legId(ref.id) } },
    contactOwnerUid: otherUid ? null : user.uid,
  };
  const batch = adminDb().batch();
  batch.set(ref, { ...tr, createdAt: FieldValue.serverTimestamp(), respondedAt: null });
  writeLeg(batch, user.uid, { id: ref.id, ...tr }, input.accountId);
  await batch.commit();

  if (otherUid) {
    const what = out ? `te pasó ${formatMoney(amount, input.currency)}` : `le pasaste ${formatMoney(amount, input.currency)}`;
    await notify(otherUid, {
      kind: "p2p-request",
      title: `${myName} registró que ${what}`,
      body: `${description}. Confirmalo y elegí en qué cuenta ${out ? "entró" : "salió"}.`,
      url: "/compartidas",
      whatsappText: `💸 *${myName}* registró que ${what}. Confirmalo desde la app (Cuentas con gente) o decime "confirmá la transferencia de ${myName}" y en qué cuenta ${out ? "entró" : "salió"}.`,
      dedupeKey: `p2p-request-${ref.id}`,
    });
  }
  return { id: ref.id, status: tr.status as "pending" | "accepted", name: otherName };
};

/** La otra persona confirma (eligiendo su cuenta) o rechaza. */
export const respondPersonTransfer = async (
  user: { uid: string },
  id: string,
  input: { accept: boolean; accountId?: string | null },
): Promise<void> => {
  const ref = col().doc(id);
  const pre = await ref.get();
  if (!pre.exists) throw new PeopleError("La transferencia ya no existe", 404);
  const current = toTransfer(pre);
  if (input.accept) {
    if (!input.accountId) throw new PeopleError("Elegí en qué cuenta");
    await checkAccount(user.uid, input.accountId, current.currency);
  }
  const result = await adminDb().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const tr = toTransfer(snap);
    if (!tr.uids.includes(user.uid) || tr.createdByUid === user.uid) {
      throw new PeopleError("Esta transferencia la tiene que confirmar la otra persona", 403);
    }
    const next = input.accept ? "accepted" : "rejected";
    if (tr.status === next) return null;
    if (tr.status !== "pending") throw new PeopleError("Ya está respondida");
    const conn = await t.get(adminDb().collection("connections").doc([...tr.uids].sort().join("_")));
    if (conn.data()?.status !== "accepted") throw new PeopleError("Ya no están conectados");
    const legs = { ...tr.legs };
    if (input.accept) legs[user.uid] = { accountId: input.accountId!, txId: writeLeg(t, user.uid, tr, input.accountId!) };
    t.update(ref, { status: next, legs, respondedAt: FieldValue.serverTimestamp() });
    return tr;
  });
  if (!result) return;
  const side = transferSide(result, user.uid)!;
  const myName = side.direction === "in" ? result.toName : result.fromName;
  await notify(result.createdByUid, {
    kind: "p2p-response",
    title: input.accept ? `${myName} confirmó la transferencia` : `${myName} no reconoce la transferencia`,
    body: input.accept
      ? `${formatMoney(result.amount, result.currency)} · ${result.description}. Ya cuenta para lo que se deben.`
      : `${formatMoney(result.amount, result.currency)} · ${result.description}. Fijate si está bien; si fue un error, borrala.`,
    url: "/compartidas",
    dedupeKey: `p2p-response-${id}`,
  });
};

/**
 * Borrar: si estaba pendiente queda cancelada; si ya estaba confirmada (o
 * rechazada) se anula. En los dos casos se borra de las cuentas de los dos.
 */
export const cancelPersonTransfer = async (user: { uid: string }, id: string): Promise<void> => {
  const ref = col().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const tr = toTransfer(snap);
  if (!tr.uids.includes(user.uid)) throw new PeopleError("No es tuya", 403);
  if (tr.status === "pending" && tr.createdByUid !== user.uid) {
    throw new PeopleError("Está esperando que la confirmes: aceptala o rechazala");
  }
  for (const uid of Object.keys(tr.legs ?? {})) await deleteLeg(uid, id);
  await ref.update({
    status: tr.status === "pending" ? "cancelled" : "voided",
    legs: {},
    respondedAt: FieldValue.serverTimestamp(),
  });
  const other = tr.uids.find((u) => u !== user.uid);
  if (other && tr.status === "accepted") {
    const side = transferSide(tr, user.uid)!;
    await notify(other, {
      kind: "p2p-response",
      title: `${side.direction === "out" ? tr.fromName : tr.toName} borró una transferencia`,
      body: `${formatMoney(tr.amount, tr.currency)} · ${tr.description}. Ya no cuenta para lo que se deben.`,
      url: "/compartidas",
      dedupeKey: `p2p-voided-${id}`,
    });
  }
};

/** Transferencias donde participo. */
export const loadTransfersFor = async (uid: string): Promise<PersonTransfer[]> =>
  (await col().where("uids", "array-contains", uid).get()).docs.map(toTransfer);
