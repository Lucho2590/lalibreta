import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import {
  otherUid,
  pairId,
  profileName,
  type Connection,
  type ConnectionProfile,
} from "@/lib/domain/people";
import { normalizePhone, parseContactQuery, phoneVariants, type ContactQuery } from "@/lib/domain/phone";
import { MAX_BOOK_CONTACTS, type BookContact } from "@/lib/domain/address-book";

/**
 * Conexiones entre usuarios (connections/{pairId}). Una persona le manda una
 * solicitud a otra (por su email) y la otra acepta o rechaza. Solo entre
 * personas conectadas se puede repartir un gasto o registrar transferencias.
 * Todo pasa por acá (Admin SDK): el cliente solo lee.
 */

export class PeopleError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const col = () => adminDb().collection("connections");

const contactIdFromEmail = (email: string) => email.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");

export const loadProfile = async (uid: string): Promise<ConnectionProfile> => {
  const d = (await adminDb().collection("users").doc(uid).get()).data() ?? {};
  return {
    email: String(d.email ?? "").toLowerCase(),
    displayName: (d.displayName as string | null | undefined) ?? null,
    photoURL: (d.photoURL as string | null | undefined) ?? null,
  };
};

export const getConnection = async (a: string, b: string): Promise<Connection | null> => {
  const snap = await col().doc(pairId(a, b)).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Connection) : null;
};

/** ¿Están conectados (aceptada)? Es el chequeo que vale, no el linkedUid del contacto. */
export const areConnected = async (a: string, b: string) => (await getConnection(a, b))?.status === "accepted";

/** Al conectarse, cada uno queda como contacto del otro (para elegirlo en listas y en el agente). */
const linkContacts = async (a: { uid: string; profile: ConnectionProfile }, b: { uid: string; profile: ConnectionProfile }) => {
  const batch = adminDb().batch();
  for (const [me, other] of [
    [a, b],
    [b, a],
  ] as const) {
    if (!other.profile.email) continue;
    batch.set(
      adminDb().doc(`users/${me.uid}/contacts/${contactIdFromEmail(other.profile.email)}`),
      {
        email: other.profile.email,
        displayName: other.profile.displayName,
        photoURL: other.profile.photoURL,
        linkedUid: other.uid,
        kind: "app",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  await batch.commit();
};

export interface FoundUser {
  uid: string;
  profile: ConnectionProfile;
}

/** Usuario de la app con ese email (el de su cuenta). */
export const findUserByEmail = async (email: string): Promise<FoundUser | null> => {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const found = await adminDb().collection("users").where("email", "==", target).limit(1).get();
  const d = found.docs[0];
  if (!d) return null;
  const data = d.data();
  return {
    uid: d.id,
    profile: {
      email: String(data.email ?? "").toLowerCase(),
      displayName: (data.displayName as string | null | undefined) ?? null,
      photoURL: (data.photoURL as string | null | undefined) ?? null,
    },
  };
};

/** Usuario de la app que tiene ese WhatsApp vinculado (waId normalizado). */
export const findUserByPhone = async (waId: string): Promise<FoundUser | null> => {
  const snaps = await Promise.all(phoneVariants(waId).map((id) => adminDb().collection("whatsappLinks").doc(id).get()));
  const uid = snaps.map((s) => (s.exists ? (s.data()?.uid as string | undefined) : undefined)).find(Boolean);
  return uid ? { uid, profile: await loadProfile(uid) } : null;
};

export const findUserByQuery = (q: NonNullable<ContactQuery>) =>
  q.kind === "email" ? findUserByEmail(q.value) : findUserByPhone(q.value);

/** Cómo estoy con otro usuario: conectados, solicitud enviada/recibida o nada. */
export type ConnectionState = "self" | "connected" | "outgoing" | "incoming" | "none";

export const connectionState = async (meUid: string, otherId: string): Promise<{ state: ConnectionState; id: string | null }> => {
  if (otherId === meUid) return { state: "self", id: null };
  const c = await getConnection(meUid, otherId);
  if (c?.status === "accepted") return { state: "connected", id: c.id };
  if (c?.status === "pending") return { state: c.requesterUid === meUid ? "outgoing" : "incoming", id: c.id };
  return { state: "none", id: null };
};

export const NOT_A_USER_EMAIL =
  "Esa persona no usa La Libreta (o se registró con otro email). Podés invitarla o agregarla como contacto sin app.";
export const NOT_A_USER_PHONE =
  "Ese número no tiene La Libreta vinculada a su WhatsApp. Podés invitarlo o agregarlo como contacto sin app.";

/** Solicitud de conexión a otro usuario (por email). Si él ya me la había mandado, queda aceptada. */
export const requestConnection = async (
  me: { uid: string },
  email: string,
): Promise<{ status: "pending" | "accepted"; name: string }> => {
  const target = email.trim().toLowerCase();
  if (!target.includes("@")) throw new PeopleError("Ingresá un email válido");
  const found = await findUserByEmail(target);
  if (!found) throw new PeopleError(NOT_A_USER_EMAIL, 404);
  return requestConnectionTo(me, found.uid);
};

/** Solicitud de conexión por email o por su número de WhatsApp. */
export const requestConnectionByQuery = async (
  me: { uid: string },
  raw: string,
): Promise<{ status: "pending" | "accepted"; name: string }> => {
  const q = parseContactQuery(raw);
  if (!q) throw new PeopleError("Escribí su email o su número de WhatsApp (con característica)");
  const found = await findUserByQuery(q);
  if (!found) throw new PeopleError(q.kind === "email" ? NOT_A_USER_EMAIL : NOT_A_USER_PHONE, 404);
  return requestConnectionTo(me, found.uid);
};

/** Solicitud de conexión a un usuario ya encontrado. Si él ya me la había mandado, queda aceptada. */
export const requestConnectionTo = async (
  me: { uid: string },
  otherId: string,
): Promise<{ status: "pending" | "accepted"; name: string }> => {
  if (otherId === me.uid) throw new PeopleError("Ese sos vos 🙂");
  const [mine, theirs] = await Promise.all([loadProfile(me.uid), loadProfile(otherId)]);
  const ref = col().doc(pairId(me.uid, otherId));

  const result = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const c = snap.exists ? (snap.data() as Omit<Connection, "id">) : null;
    if (c?.status === "accepted") return "already" as const;
    // Me la había mandado él: la acepto.
    if (c?.status === "pending" && c.requesterUid === otherId) {
      tx.update(ref, { status: "accepted", respondedAt: FieldValue.serverTimestamp() });
      return "accepted" as const;
    }
    if (c?.status === "pending") return "resent" as const;
    tx.set(ref, {
      uids: [me.uid, otherId].sort(),
      requesterUid: me.uid,
      addresseeUid: otherId,
      status: "pending",
      profiles: { [me.uid]: mine, [otherId]: theirs },
      createdAt: FieldValue.serverTimestamp(),
      respondedAt: null,
    });
    return "created" as const;
  });

  const myName = profileName(mine);
  if (result === "accepted") {
    await linkContacts({ uid: me.uid, profile: mine }, { uid: otherId, profile: theirs });
    await notify(otherId, {
      kind: "connection-response",
      title: `${myName} aceptó tu solicitud`,
      body: "Ya pueden repartir gastos y registrar transferencias entre ustedes.",
      url: "/contactos",
      dedupeKey: `connection-accepted-${ref.id}`,
    });
    return { status: "accepted", name: profileName(theirs) };
  }
  if (result === "created") {
    await notify(otherId, {
      kind: "connection-request",
      title: `${myName} quiere conectarse con vos`,
      body: "Si aceptás, van a poder repartir gastos y registrar transferencias entre ustedes.",
      url: "/contactos",
      whatsappText: `👋 *${myName}* quiere conectarse con vos en La Libreta para repartir gastos. Entrá a Contactos en la app para aceptar.`,
      dedupeKey: `connection-request-${ref.id}-${Date.now()}`,
    });
  }
  return { status: result === "already" ? "accepted" : "pending", name: profileName(theirs) };
};

/** Aceptar o rechazar una solicitud que me mandaron. */
export const respondConnection = async (me: { uid: string }, id: string, accept: boolean): Promise<void> => {
  const ref = col().doc(id);
  const c = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PeopleError("La solicitud ya no existe", 404);
    const data = { id: snap.id, ...snap.data() } as Connection;
    if (!data.uids.includes(me.uid)) throw new PeopleError("No es tuya", 403);
    if (data.status !== "pending") return null;
    if (data.addresseeUid !== me.uid) throw new PeopleError("La solicitud la mandaste vos: esperá que la otra persona responda");
    tx.update(ref, { status: accept ? "accepted" : "rejected", respondedAt: FieldValue.serverTimestamp() });
    return data;
  });
  if (!c) return;
  const other = c.requesterUid;
  const myName = profileName(c.profiles[me.uid]);
  if (accept) {
    await linkContacts({ uid: me.uid, profile: c.profiles[me.uid] }, { uid: other, profile: c.profiles[other] });
  }
  await notify(other, {
    kind: "connection-response",
    title: accept ? `${myName} aceptó tu solicitud` : `${myName} no aceptó tu solicitud`,
    body: accept
      ? "Ya pueden repartir gastos y registrar transferencias entre ustedes."
      : "Si fue un error, pueden volver a intentarlo.",
    url: "/contactos",
    dedupeKey: `connection-${accept ? "accepted" : "rejected"}-${id}-${Date.now()}`,
  });
};

/**
 * Cancelar una solicitud enviada o desconectarse. Los repartos y
 * transferencias pendientes entre los dos se cancelan; lo aceptado queda
 * (historial y saldo).
 */
export const removeConnection = async (me: { uid: string }, id: string): Promise<void> => {
  const ref = col().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const c = { id: snap.id, ...snap.data() } as Connection;
  if (!c.uids.includes(me.uid)) throw new PeopleError("No es tuya", 403);
  await ref.update({ status: "removed", respondedAt: FieldValue.serverTimestamp() });
  const other = otherUid(c, me.uid);

  // Pendientes entre los dos: se cancelan.
  const db = adminDb();
  const transfers = await db.collection("p2pTransfers").where("uids", "array-contains", me.uid).get();
  for (const d of transfers.docs) {
    const t = d.data();
    if (t.status === "pending" && (t.uids as string[]).includes(other)) {
      await d.ref.update({ status: "cancelled", respondedAt: FieldValue.serverTimestamp() });
    }
  }
  const splits = await db.collection("splits").where("uids", "array-contains", me.uid).get();
  for (const d of splits.docs) {
    const s = d.data();
    if (!(s.uids as string[]).includes(other)) continue;
    const participants = (s.participants as Array<{ uid: string | null; status: string }>).map((p) =>
      p.status === "pending" && (p.uid === other || p.uid === me.uid) ? { ...p, status: "rejected", rejectReason: "Se desconectaron" } : p,
    );
    await d.ref.update({ participants, updatedAt: FieldValue.serverTimestamp() });
  }
  if (c.status === "accepted") {
    await notify(other, {
      kind: "connection-response",
      title: `${profileName(c.profiles[me.uid])} se desconectó`,
      body: "Lo que tenían cargado entre ustedes queda en el historial.",
      url: "/compartidas",
      dedupeKey: `connection-removed-${id}-${Date.now()}`,
    });
  }
};

export interface BookMatch {
  name: string;
  phones: string[];
  emails: string[];
  /** Usuario de la app que coincide (por su WhatsApp vinculado o su email). */
  user: {
    /** Con qué dato se lo encontró (para mandarle la solicitud). */
    q: string;
    name: string;
    photoURL: string | null;
    state: ConnectionState;
  } | null;
  /** Ya lo tengo agendado sin app (mismo teléfono o email). */
  offlineContactId: string | null;
}

/**
 * ¿Quiénes de estos contactos de la agenda usan La Libreta? En lote: los
 * teléfonos contra whatsappLinks y los emails contra users. Nunca devuelve
 * uids ni el email de su cuenta.
 */
export const lookupBookContacts = async (meUid: string, contacts: BookContact[]): Promise<BookMatch[]> => {
  const db = adminDb();
  const list = contacts.slice(0, MAX_BOOK_CONTACTS);

  // Teléfonos → uid (cada número en sus dos formas).
  const phoneIds = [...new Set(list.flatMap((c) => c.phones.flatMap(phoneVariants)))];
  const phoneToUid = new Map<string, string>();
  for (let i = 0; i < phoneIds.length; i += 300) {
    const refs = phoneIds.slice(i, i + 300).map((id) => db.collection("whatsappLinks").doc(id));
    if (!refs.length) continue;
    for (const s of await db.getAll(...refs)) {
      const uid = s.exists ? (s.data()?.uid as string | undefined) : undefined;
      if (uid) phoneToUid.set(s.id, uid);
    }
  }
  // Emails → uid.
  const emails = [...new Set(list.flatMap((c) => c.emails))];
  const emailToUid = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 30) {
    const snap = await db.collection("users").where("email", "in", emails.slice(i, i + 30)).get();
    for (const d of snap.docs) emailToUid.set(String(d.data().email ?? "").toLowerCase(), d.id);
  }

  // Mis contactos sin app, para no ofrecer agendar dos veces al mismo.
  const offline = (await db.collection(`users/${meUid}/contacts`).get()).docs
    .map((d) => ({ id: d.id, ...(d.data() as { phone?: string | null; email?: string | null; linkedUid?: string | null; kind?: string }) }))
    .filter((c) => !c.linkedUid && c.kind !== "app");
  const offlineByKey = new Map<string, string>();
  for (const c of offline) {
    const p = c.phone ? normalizePhone(c.phone) : null;
    if (p) offlineByKey.set(p, c.id);
    if (c.email) offlineByKey.set(c.email.toLowerCase(), c.id);
  }

  const uids = new Set<string>();
  const hits = list.map((c) => {
    for (const p of c.phones) {
      const uid = phoneVariants(p).map((v) => phoneToUid.get(v)).find(Boolean);
      if (uid) return { uid, q: p };
    }
    for (const e of c.emails) {
      const uid = emailToUid.get(e);
      if (uid) return { uid, q: e };
    }
    return null;
  });
  hits.forEach((h) => h && uids.add(h.uid));

  const [profiles, conns] = await Promise.all([
    Promise.all([...uids].map(async (u) => [u, await loadProfile(u)] as const)),
    db.collection("connections").where("uids", "array-contains", meUid).get(),
  ]);
  const profileOf = new Map(profiles);
  const connOf = new Map<string, Connection>();
  for (const d of conns.docs) {
    const c = { id: d.id, ...d.data() } as Connection;
    connOf.set(otherUid(c, meUid), c);
  }
  const stateOf = (uid: string): ConnectionState => {
    if (uid === meUid) return "self";
    const c = connOf.get(uid);
    if (c?.status === "accepted") return "connected";
    if (c?.status === "pending") return c.requesterUid === meUid ? "outgoing" : "incoming";
    return "none";
  };

  const shownUser = new Set<string>();
  return list.map((c, i) => {
    const h = hits[i];
    // El mismo usuario en dos contactos de la agenda: lo muestro una vez.
    const user =
      h && !shownUser.has(h.uid)
        ? { q: h.q, name: profileName(profileOf.get(h.uid)), photoURL: profileOf.get(h.uid)?.photoURL ?? null, state: stateOf(h.uid) }
        : null;
    if (h) shownUser.add(h.uid);
    const offlineContactId = [...c.phones, ...c.emails].map((k) => offlineByKey.get(k)).find(Boolean) ?? null;
    return { name: c.name, phones: c.phones, emails: c.emails, user, offlineContactId };
  });
};
