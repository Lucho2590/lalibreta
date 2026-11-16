import "server-only";

import { adminDb } from "./firebase-admin";
import { loadSplitsFor } from "./splits";
import { loadTransfersFor } from "./person-transfers";
import {
  contactRef,
  otherUid,
  participantSchedule,
  profileName,
  transferSide,
  userRef,
  type Connection,
  type PersonRef,
  type PersonTransfer,
  type Split,
} from "@/lib/domain/people";
import { formatMoney } from "@/lib/format";

/** Persona con la que el usuario puede dividir gastos o transferir. */
export interface AgentPerson {
  ref: PersonRef;
  name: string;
  isApp: boolean;
}

/** Algo que le mandaron al usuario y tiene que responder. */
export interface AgentPending {
  id: string;
  type: "connection" | "split" | "transfer";
  text: string;
}

export interface PeopleContext {
  people: AgentPerson[];
  pending: AgentPending[];
  splits: Split[];
  transfers: PersonTransfer[];
}

/** Personas (conexiones aceptadas + contactos sin app) y lo pendiente, para el agente. */
export const loadPeopleContext = async (uid: string): Promise<PeopleContext> => {
  const db = adminDb();
  const [connSnap, contactsSnap, splits, transfers] = await Promise.all([
    db.collection("connections").where("uids", "array-contains", uid).get(),
    db.collection(`users/${uid}/contacts`).get(),
    loadSplitsFor(uid),
    loadTransfersFor(uid),
  ]);
  const connections = connSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Connection);
  const people: AgentPerson[] = [];
  for (const c of connections) {
    if (c.status !== "accepted") continue;
    const other = otherUid(c, uid);
    people.push({ ref: userRef(other), name: profileName(c.profiles?.[other]), isApp: true });
  }
  for (const d of contactsSnap.docs) {
    const c = d.data();
    if (c.linkedUid || c.kind === "app") continue;
    people.push({ ref: contactRef(d.id), name: String(c.displayName || c.email || "Contacto"), isApp: false });
  }

  const pending: AgentPending[] = [];
  for (const c of connections) {
    if (c.status === "pending" && c.addresseeUid === uid) {
      pending.push({ id: c.id, type: "connection", text: `${profileName(c.profiles?.[c.requesterUid])} quiere conectarse con vos` });
    }
  }
  for (const s of splits) {
    const me = s.participants.find((p) => p.uid === uid);
    if (s.status === "active" && s.ownerUid !== uid && me?.status === "pending") {
      const n = participantSchedule(s, me.amount).length;
      pending.push({
        id: s.id,
        type: "split",
        text: `${s.ownerName} te asignó ${formatMoney(me.amount, s.currency)}${n > 1 ? ` en ${n} cuotas` : ""} de "${s.description}"`,
      });
    }
  }
  for (const t of transfers) {
    const side = transferSide(t, uid);
    if (t.status === "pending" && t.createdByUid !== uid && side) {
      pending.push({
        id: t.id,
        type: "transfer",
        text: `${side.name} registró que ${side.direction === "in" ? "te pasó" : "le pasaste"} ${formatMoney(t.amount, t.currency)} ("${t.description}")`,
      });
    }
  }
  return { people: people.sort((a, b) => a.name.localeCompare(b.name, "es")), pending, splits, transfers };
};

/**
 * Contacto sin la app creado desde el agente ("le compré algo a Juan"). Si ya
 * hay uno con ese nombre, usa ese.
 */
export const ensureOfflineContact = async (uid: string, name: string): Promise<PersonRef> => {
  const clean = name.trim();
  const col = adminDb().collection(`users/${uid}/contacts`);
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const existing = (await col.get()).docs.find(
    (d) => !d.data().linkedUid && d.data().kind !== "app" && norm(String(d.data().displayName ?? "")) === norm(clean),
  );
  if (existing) return contactRef(existing.id);
  const ref = await col.add({
    displayName: clean,
    email: null,
    phone: null,
    linkedUid: null,
    kind: "offline",
    photoURL: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return contactRef(ref.id);
};
