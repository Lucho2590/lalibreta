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

/** Solicitud de conexión a otro usuario (por email). Si él ya me la había mandado, queda aceptada. */
export const requestConnection = async (
  me: { uid: string },
  email: string,
): Promise<{ status: "pending" | "accepted"; name: string }> => {
  const target = email.trim().toLowerCase();
  if (!target.includes("@")) throw new PeopleError("Ingresá un email válido");
  const found = await adminDb().collection("users").where("email", "==", target).limit(1).get();
  if (found.empty) {
    throw new PeopleError(
      "Esa persona no usa La Libreta (o se registró con otro email). Podés agregarla como contacto sin app.",
      404,
    );
  }
  const otherId = found.docs[0].id;
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
