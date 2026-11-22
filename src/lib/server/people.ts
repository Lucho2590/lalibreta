import "server-only";

import { adminDb } from "./firebase-admin";

import { loadSplitsFor } from "./splits";
import { loadTransfersFor } from "./person-transfers";
import { loadSplitRules, type SplitRule } from "./split-rules";
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
import {
  cleanNicknames,
  cleanPayAliasValue,
  cleanPayAliases,
  contactDisplayName,
  contactIdFromEmail,
  normName,
  type PayAlias,
} from "@/lib/domain/contact-info";

interface ContactDoc {
  email?: string | null;
  displayName?: string | null;
  customName?: string | null;
  nicknames?: string[] | null;
  payAliases?: PayAlias[] | null;
  linkedUid?: string | null;
  kind?: string | null;
}

/** Persona con la que el usuario puede dividir gastos o transferir. */
export interface AgentPerson {
  ref: PersonRef;
  name: string;
  isApp: boolean;
  /** Su doc en users/{uid}/contacts (los conectados viejos pueden no tenerlo). */
  contactId: string | null;
  /** Otras formas en que el usuario lo nombra. */
  nicknames: string[];
  payAliases: PayAlias[];
  /** Email de su cuenta (solo los que usan la app; para crearle el contacto si falta). */
  email?: string | null;
  displayName?: string | null;
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
  /** "Dividir siempre" (comercios que se dividen solos). */
  rules: SplitRule[];
}

/** Personas (conexiones aceptadas + contactos sin app) y lo pendiente, para el agente. */
export const loadPeopleContext = async (uid: string): Promise<PeopleContext> => {
  const db = adminDb();
  const [connSnap, contactsSnap, splits, transfers, rules] = await Promise.all([
    db.collection("connections").where("uids", "array-contains", uid).get(),
    db.collection(`users/${uid}/contacts`).get(),
    loadSplitsFor(uid),
    loadTransfersFor(uid),
    loadSplitRules(uid),
  ]);
  const connections = connSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Connection);
  const contacts = contactsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as ContactDoc) }));
  const byUid = new Map(contacts.filter((c) => c.linkedUid).map((c) => [String(c.linkedUid), c]));
  const people: AgentPerson[] = [];
  for (const c of connections) {
    if (c.status !== "accepted") continue;
    const other = otherUid(c, uid);
    const profile = c.profiles?.[other];
    const mine = byUid.get(other);
    people.push({
      ref: userRef(other),
      name: mine?.customName?.trim() || profileName(profile),
      isApp: true,
      contactId: mine?.id ?? null,
      nicknames: mine?.nicknames ?? [],
      payAliases: mine?.payAliases ?? [],
      email: profile?.email ?? null,
      displayName: profile?.displayName ?? null,
    });
  }
  for (const c of contacts) {
    if (c.linkedUid || c.kind === "app") continue;
    people.push({
      ref: contactRef(c.id),
      name: contactDisplayName(c),
      isApp: false,
      contactId: c.id,
      nicknames: c.nicknames ?? [],
      payAliases: c.payAliases ?? [],
    });
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
        text: `${s.ownerName} te asignó ${formatMoney(me.amount, s.currency)}${n > 1 ? ` en ${n} cuotas` : ""} de "${s.description}"${s.ruleId ? " (se repite todos los meses: puede aceptarlo siempre)" : ""}`,
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
  return { people: people.sort((a, b) => a.name.localeCompare(b.name, "es")), pending, splits, transfers, rules };
};

/**
 * Contacto sin la app creado desde el agente ("le compré algo a Juan"). Si ya
 * hay uno con ese nombre, usa ese.
 */
export const ensureOfflineContact = async (uid: string, name: string): Promise<PersonRef> => {
  const clean = name.trim();
  const col = adminDb().collection(`users/${uid}/contacts`);
  const existing = (await col.get()).docs.find((d) => {
    const c = d.data() as ContactDoc;
    if (c.linkedUid || c.kind === "app") return false;
    return [c.displayName, ...(c.nicknames ?? [])].some((n) => n && normName(n) === normName(clean));
  });
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

export interface ContactInfoPatch {
  /** Sin la app: su nombre. Con la app: el nombre que le pone el usuario. */
  name?: string;
  addNicknames?: string[];
  removeNicknames?: string[];
  addPayAliases?: PayAlias[];
  removePayAliases?: string[];
  phone?: string;
  email?: string;
}

/**
 * Edita la ficha de una persona desde el agente ("el alias de Juan es
 * juan.mp", "a Ornella decile Orne"). A un conectado sin contacto (conexión
 * vieja) se lo crea. Devuelve cómo quedó.
 */
export const saveContactInfoAdmin = async (
  uid: string,
  person: AgentPerson,
  patch: ContactInfoPatch,
): Promise<{ name: string; nicknames: string[]; payAliases: PayAlias[] }> => {
  const col = adminDb().collection(`users/${uid}/contacts`);
  let ref = person.contactId ? col.doc(person.contactId) : null;
  if (!ref) {
    if (!person.isApp || !person.email) throw new Error("No encontré el contacto de esa persona.");
    ref = col.doc(contactIdFromEmail(person.email));
    const exists = (await ref.get()).exists;
    await ref.set(
      {
        email: person.email,
        displayName: person.displayName ?? null,
        linkedUid: person.ref.slice(2),
        kind: "app",
        ...(exists ? {} : { createdAt: new Date(), photoURL: null }),
        updatedAt: new Date(),
      },
      { merge: true },
    );
  }
  const current = ((await ref.get()).data() ?? {}) as ContactDoc & { phone?: string | null };
  const isApp = person.isApp;
  const newName = patch.name?.trim() || null;
  const mainName = newName ?? (isApp ? current.customName || current.displayName : current.displayName) ?? null;

  const drop = new Set((patch.removeNicknames ?? []).map(normName));
  const nicknames = cleanNicknames(
    [...(current.nicknames ?? []).filter((n) => !drop.has(normName(n))), ...(patch.addNicknames ?? [])],
    mainName,
  );
  const dropAlias = new Set((patch.removePayAliases ?? []).map((a) => cleanPayAliasValue(a).toLowerCase()));
  // Si vuelve a pasar un alias que ya estaba (ej. con otra etiqueta), queda el nuevo.
  const added = cleanPayAliases(patch.addPayAliases ?? []);
  const addedKeys = new Set(added.map((a) => a.value.toLowerCase()));
  const payAliases = cleanPayAliases([
    ...(current.payAliases ?? []).filter(
      (a) => !dropAlias.has(a.value.toLowerCase()) && !addedKeys.has(a.value.toLowerCase()),
    ),
    ...added,
  ]);

  const update: Record<string, unknown> = { nicknames, payAliases, updatedAt: new Date() };
  if (newName) {
    if (isApp) update.customName = newName === current.displayName?.trim() ? null : newName;
    else update.displayName = newName;
  }
  if (patch.phone !== undefined) update.phone = patch.phone.trim() || null;
  if (patch.email !== undefined && !isApp) update.email = patch.email.trim().toLowerCase() || null;
  await ref.update(update);

  const name = contactDisplayName({
    customName: isApp ? ("customName" in update ? (update.customName as string | null) : current.customName) : null,
    displayName: (update.displayName as string | undefined) ?? current.displayName,
    email: current.email,
  });
  return { name, nicknames, payAliases };
};
