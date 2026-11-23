import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import { PeopleError, areConnected, findUserByQuery, loadProfile, requestConnectionTo } from "./connections";
import { sendEmailInvite } from "./invites";
import { parseContactQuery } from "@/lib/domain/phone";
import { tryGetAppRates } from "./fx";
import { dateFromYMD, isYMD, todayYMD } from "./time";
import { createTransactionAdmin, type ServerAccount } from "./transactions-admin";
import { isVirtualAccountId, parsePersonRef, profileName, type PersonRef } from "@/lib/domain/people";
import { accountCurrencies, isCurrency, type AccountType, type Currency } from "@/lib/domain/types";
import {
  checkPaidBy,
  computeExpenseBooks,
  computeShares,
  crossRate,
  firstName,
  normalizeVaquitaDates,
  summarizeVaquita,
  vaquitaAccountId,
  type Vaquita,
  type VaquitaExpense,
  type VaquitaFamily,
  type VaquitaLeg,
  type VaquitaMember,
  type VaquitaPayment,
  type VaquitaSplitMode,
} from "@/lib/domain/vaquitas";
import { currencyLabel, formatMoney } from "@/lib/format";

/**
 * Vaquitas (ver lib/domain/vaquitas.ts). Todo se escribe acá con Admin SDK:
 * los integrantes con la app ven y editan todo, y cada gasto se refleja en
 * las cuentas de cada uno (su gasto real si pagó, o su parte contra la
 * "cuenta" de la vaquita).
 */

const db = () => adminDb();
const col = () => db().collection("vaquitas");
const expensesCol = (vid: string) => col().doc(vid).collection("expenses");
const paymentsCol = (vid: string) => col().doc(vid).collection("payments");

/**
 * vaquitaLinks/{vaquitaId}_{memberId} — solo server. A quién hay que
 * vincular un integrante "sin la app" cuando se pueda: kind uid (le mandamos
 * la solicitud: al aceptar), email / phone (lo invitamos: al registrarse o
 * vincular su WhatsApp). Lo resuelve lib/server/vaquita-links.ts.
 */
export interface PendingLink {
  vaquitaId: string;
  memberId: string;
  byUid: string;
  kind: "uid" | "email" | "phone";
  value: string;
}
export const pendingLinksCol = () => db().collection("vaquitaLinks");
const pendingLinkId = (vaquitaId: string, memberId: string) => `${vaquitaId}_${memberId}`;
const savePendingLink = (p: PendingLink) =>
  pendingLinksCol().doc(pendingLinkId(p.vaquitaId, p.memberId)).set({ ...p, createdAt: FieldValue.serverTimestamp() });
const dropPendingLink = (vaquitaId: string, memberId: string) =>
  pendingLinksCol().doc(pendingLinkId(vaquitaId, memberId)).delete();
const round2 = (n: number) => Math.round(n * 100) / 100;
const newId = (prefix: string) => `${prefix}${randomBytes(5).toString("hex")}`;

/** Ids de los asientos en las cuentas de cada usuario. */
const realTxId = (eid: string) => `vq_${eid}`;
const partTxId = (eid: string) => `vqp_${eid}`;
const paymentTxId = (pid: string) => `vqpay_${pid}`;

const toVaquita = (snap: FirebaseFirestore.DocumentSnapshot): Vaquita => ({ id: snap.id, ...snap.data() }) as Vaquita;

export const loadVaquita = async (id: string): Promise<Vaquita> => {
  if (!id || typeof id !== "string") throw new PeopleError("Falta la vaquita");
  const snap = await col().doc(id).get();
  if (!snap.exists) throw new PeopleError("Esa vaquita no existe", 404);
  return toVaquita(snap);
};

const loadMember = async (uid: string, id: string): Promise<Vaquita> => {
  const v = await loadVaquita(id);
  if (!v.uids.includes(uid)) throw new PeopleError("No participás de esta vaquita", 403);
  return v;
};

const memberOf = (v: Vaquita, uid: string) => v.members.find((m) => m.uid === uid) ?? null;
const indexUids = (members: VaquitaMember[]) => [...new Set(members.map((m) => m.uid).filter((u): u is string => !!u))];

const cleanName = (s: unknown, max = 60) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

// === Categoría de cada uno ===

/** Categoría de gastos para la vaquita: "Viajes" si hay, si no "Salidas", si no la primera. */
const guessCategory = async (uid: string): Promise<string> => {
  const snap = await db().collection(`users/${uid}/categories`).where("kind", "==", "expense").get();
  const cats = snap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? "") }));
  const find = (re: RegExp) => cats.find((c) => re.test(c.name.toLowerCase()));
  return (
    find(/viaj|vacac|turism/)?.id ??
    find(/salida/)?.id ??
    cats.sort((a, b) => a.name.localeCompare(b.name, "es"))[0]?.id ??
    ""
  );
};

const checkCategory = async (uid: string, categoryId: string) => {
  const c = (await db().doc(`users/${uid}/categories/${categoryId}`).get()).data();
  if (!c || c.kind !== "expense") throw new PeopleError("Esa categoría no existe");
};

// === Cotizaciones ===

/**
 * Unidades de la moneda de la vaquita por 1 de `from`. Si viene una
 * cotización a mano (> 0) se usa esa; si no, la oficial del día.
 */
const resolveRate = async (from: Currency, to: Currency, date: string, manual?: number | null) => {
  if (from === to) return 1;
  if (manual && manual > 0 && Number.isFinite(manual)) return Math.round(manual * 1e6) / 1e6;
  const fx = await tryGetAppRates(date);
  const r = crossRate(from, to, fx?.rates);
  if (!r) {
    throw new PeopleError(
      `No conseguí la cotización de ${currencyLabel(from).toLowerCase()} a ${currencyLabel(to).toLowerCase()}. Ponela a mano.`,
    );
  }
  return r;
};

// === Integrantes ===

export interface MemberInput {
  /** Alguien de la app (u:) o un contacto (c:). */
  ref?: PersonRef;
  /** Alguien sin la app, solo con el nombre (o el nombre de quien se busca por `q`). */
  name?: string;
  /**
   * Su WhatsApp o su email: si es un contacto, entra con la app; si usa La
   * Libreta pero no estamos conectados, le mando la solicitud; si no la usa,
   * lo invito. En los dos últimos casos entra "sin la app" y se vincula solo
   * cuando acepta / se registra.
   */
  q?: string;
  /** Id de familia (de las que vienen en la misma llamada o ya existentes). */
  familyId?: string | null;
}

/** Lo que queda por hacer con un integrante buscado por `q` cuando ya existe la vaquita. */
type MemberFollowUp = { memberId: string; kind: PendingLink["kind"]; value: string; inviteEmail?: string };

/** Arma un integrante nuevo (valida que sea una conexión o un contacto mío). */
const buildMember = async (
  me: string,
  input: MemberInput,
  existing: VaquitaMember[],
  followUps: MemberFollowUp[] = [],
): Promise<VaquitaMember> => {
  const familyId = input.familyId ?? null;
  if (input.q && !input.ref) {
    const q = parseContactQuery(input.q);
    if (!q) throw new PeopleError("Escribí su email o su WhatsApp (con característica)");
    const found = await findUserByQuery(q);
    if (found) {
      if (found.uid === me) throw new PeopleError("Ese sos vos");
      if (existing.some((m) => m.uid === found.uid)) throw new PeopleError(`${profileName(found.profile)} ya está en la vaquita`);
      if (await areConnected(me, found.uid)) return buildMember(me, { ref: `u:${found.uid}`, familyId }, existing);
      const r = await requestConnectionTo({ uid: me }, found.uid);
      if (r.status === "accepted") return buildMember(me, { ref: `u:${found.uid}`, familyId }, existing);
      const id = newId("m_");
      followUps.push({ memberId: id, kind: "uid", value: found.uid });
      return { id, name: cleanName(profileName(found.profile)) || "Alguien", uid: null, email: null, familyId, pendingLink: "request" };
    }
    const name = cleanName(input.name);
    if (!name) throw new PeopleError("No usa La Libreta: decime cómo se llama");
    const id = newId("m_");
    followUps.push({ memberId: id, kind: q.kind, value: q.value, ...(q.kind === "email" ? { inviteEmail: q.value } : {}) });
    return { id, name, uid: null, email: null, familyId, pendingLink: "invite" };
  }
  if (input.ref) {
    const parsed = parsePersonRef(input.ref);
    if (!parsed) throw new PeopleError("Persona inválida");
    if (parsed.type === "user") {
      if (existing.some((m) => m.uid === parsed.uid)) throw new PeopleError("Esa persona ya está en la vaquita");
      if (parsed.uid !== me && !(await areConnected(me, parsed.uid))) {
        throw new PeopleError("Solo podés sumar gente con la que estás conectado");
      }
      const p = await loadProfile(parsed.uid);
      return { id: newId("m_"), name: profileName(p), uid: parsed.uid, email: p.email || null, familyId };
    }
    const c = (await db().doc(`users/${me}/contacts/${parsed.contactId}`).get()).data();
    if (!c) throw new PeopleError("Ese contacto no existe");
    const linked = (c.linkedUid as string | null | undefined) ?? null;
    if (linked) return buildMember(me, { ref: `u:${linked}`, familyId }, existing);
    return {
      id: newId("m_"),
      name: cleanName(c.displayName || c.email || "Contacto"),
      uid: null,
      email: (c.email as string | null | undefined) ?? null,
      familyId,
    };
  }
  const name = cleanName(input.name);
  if (!name) throw new PeopleError("Poné el nombre");
  return { id: newId("m_"), name, uid: null, email: null, familyId };
};

/** Guarda a quién vincular cada integrante buscado por `q` y manda los mails de invitación. */
const applyFollowUps = async (vaquitaId: string, byUid: string, followUps: MemberFollowUp[], names: Map<string, string>) => {
  for (const f of followUps) {
    await savePendingLink({ vaquitaId, memberId: f.memberId, byUid, kind: f.kind, value: f.value });
    if (f.inviteEmail) {
      // Si ya lo invitó hoy, no se manda de nuevo: igual queda pendiente.
      await sendEmailInvite({ uid: byUid }, f.inviteEmail, names.get(f.memberId)).catch(() => {});
    }
  }
};

const inviteNotice = async (v: Pick<Vaquita, "id" | "name">, uid: string, byName: string) => {
  await notify(uid, {
    kind: "vaquita-invite",
    title: `${firstName(byName)} te sumó a una vaquita`,
    body: `«${v.name}»: ahí ven y cargan los gastos entre todos.`,
    url: `/vaquitas/${v.id}`,
    whatsappText: `🐮 *${firstName(byName)}* te sumó a la vaquita *${v.name}*. Entrá a La Libreta para ver y cargar los gastos.`,
  });
};

export interface CreateVaquitaInput {
  name: string;
  currency: Currency;
  members: MemberInput[];
  families?: Array<{ id: string; name: string }>;
  /** Mi familia (id de `families`), si estoy en una. */
  myFamilyId?: string | null;
  /** YYYY-MM-DD: un día (solo startDate) o de startDate a endDate. */
  startDate?: string | null;
  endDate?: string | null;
}

export const createVaquita = async (user: { uid: string }, input: CreateVaquitaInput): Promise<{ id: string }> => {
  const name = cleanName(input.name);
  if (!name) throw new PeopleError("Ponele un nombre");
  if (!isCurrency(input.currency)) throw new PeopleError("Moneda inválida");
  const dates = normalizeVaquitaDates(input.startDate, input.endDate);
  if ("error" in dates) throw new PeopleError(dates.error);
  const families: VaquitaFamily[] = (input.families ?? [])
    .map((f) => ({ id: String(f.id || newId("f_")), name: cleanName(f.name, 40) }))
    .filter((f) => f.name);
  const famIds = new Set(families.map((f) => f.id));
  const fam = (id: string | null | undefined) => (id && famIds.has(id) ? id : null);

  const meProfile = await loadProfile(user.uid);
  const myName = profileName(meProfile);
  const members: VaquitaMember[] = [
    { id: newId("m_"), name: myName, uid: user.uid, email: meProfile.email || null, familyId: fam(input.myFamilyId) },
  ];
  const followUps: MemberFollowUp[] = [];
  for (const m of input.members ?? []) {
    members.push(await buildMember(user.uid, { ...m, familyId: fam(m.familyId) }, members, followUps));
  }
  if (members.length < 2) throw new PeopleError("Sumá al menos a otra persona");

  const uids = indexUids(members);
  const categoryByUid: Record<string, string> = {};
  for (const uid of uids) categoryByUid[uid] = await guessCategory(uid);

  const ref = col().doc();
  await ref.set({
    name,
    currency: input.currency,
    createdByUid: user.uid,
    members,
    families: families.filter((f) => members.some((m) => m.familyId === f.id)),
    uids,
    categoryByUid,
    startDate: dates.startDate,
    endDate: dates.endDate,
    status: "open",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  for (const uid of uids) if (uid !== user.uid) await inviteNotice({ id: ref.id, name }, uid, myName);
  await applyFollowUps(ref.id, user.uid, followUps, new Map(members.map((m) => [m.id, m.name])));
  return { id: ref.id };
};

export interface UpdateVaquitaInput {
  id: string;
  name?: string;
  currency?: Currency;
  status?: "open" | "closed";
  /** Mi categoría para los gastos de esta vaquita. */
  categoryId?: string;
  /** Cambiar las fechas (null en las dos = sin fecha). */
  dates?: { startDate: string | null; endDate: string | null };
}

export const updateVaquita = async (user: { uid: string }, input: UpdateVaquitaInput): Promise<void> => {
  const v = await loadMember(user.uid, input.id);
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  let resync = false;
  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (!name) throw new PeopleError("Ponele un nombre");
    patch.name = name;
  }
  if (input.currency !== undefined && input.currency !== v.currency) {
    if (!isCurrency(input.currency)) throw new PeopleError("Moneda inválida");
    const [e, p] = await Promise.all([expensesCol(v.id).limit(1).get(), paymentsCol(v.id).limit(1).get()]);
    if (!e.empty || !p.empty) throw new PeopleError("La moneda se puede cambiar solo antes de cargar gastos");
    patch.currency = input.currency;
  }
  if (input.status !== undefined) {
    if (input.status !== "open" && input.status !== "closed") throw new PeopleError("Estado inválido");
    patch.status = input.status;
    patch.closedAt = input.status === "closed" ? FieldValue.serverTimestamp() : null;
  }
  if (input.dates !== undefined) {
    const dates = normalizeVaquitaDates(input.dates?.startDate, input.dates?.endDate);
    if ("error" in dates) throw new PeopleError(dates.error);
    patch.startDate = dates.startDate;
    patch.endDate = dates.endDate;
  }
  if (input.categoryId !== undefined) {
    await checkCategory(user.uid, input.categoryId);
    patch[`categoryByUid.${user.uid}`] = input.categoryId;
    resync = true;
  }
  await col().doc(v.id).update(patch);
  if (resync) await resyncAllBooks(v.id, [user.uid]);
};

/** Sumar gente. */
export const addMembers = async (
  user: { uid: string },
  input: { id: string; members: MemberInput[] },
): Promise<void> => {
  const v = await loadMember(user.uid, input.id);
  const famIds = new Set(v.families.map((f) => f.id));
  const members = [...v.members];
  const added: VaquitaMember[] = [];
  const followUps: MemberFollowUp[] = [];
  for (const m of input.members ?? []) {
    const nm = await buildMember(user.uid, { ...m, familyId: m.familyId && famIds.has(m.familyId) ? m.familyId : null }, members, followUps);
    members.push(nm);
    added.push(nm);
  }
  if (!added.length) return;
  const uids = indexUids(members);
  const patch: Record<string, unknown> = { members, uids, updatedAt: FieldValue.serverTimestamp() };
  for (const m of added) {
    if (m.uid && !v.categoryByUid?.[m.uid]) patch[`categoryByUid.${m.uid}`] = await guessCategory(m.uid);
  }
  await col().doc(v.id).update(patch);
  const myName = profileName(await loadProfile(user.uid));
  for (const m of added) if (m.uid && m.uid !== user.uid) await inviteNotice(v, m.uid, myName);
  await applyFollowUps(v.id, user.uid, followUps, new Map(added.map((m) => [m.id, m.name])));
  // Si entra a una familia, cambia a los gastos de quién va cada cosa.
  if (added.some((m) => m.familyId)) await resyncAllBooks(v.id);
  await refreshSummary(v.id);
};

/** Cambiar el nombre de alguien sin la app. */
export const renameMember = async (
  user: { uid: string },
  input: { id: string; memberId: string; name: string },
): Promise<void> => {
  const v = await loadMember(user.uid, input.id);
  const name = cleanName(input.name);
  if (!name) throw new PeopleError("Poné el nombre");
  const members = v.members.map((m) => {
    if (m.id !== input.memberId) return m;
    if (m.uid) throw new PeopleError("El nombre de alguien de la app lo cambia esa persona");
    return { ...m, name };
  });
  await col().doc(v.id).update({ members, updatedAt: FieldValue.serverTimestamp() });
};

/**
 * Vincular a alguien que estaba "sin la app" con su cuenta (porque se sumó
 * después a La Libreta). Mantiene su id de integrante: sus gastos, partes y
 * pagos quedan como estaban; desde ahora ve la vaquita y su parte va a sus
 * cuentas.
 */
export const linkMember = async (
  user: { uid: string },
  input: { id: string; memberId: string; ref: PersonRef },
): Promise<{ name: string }> => {
  const v = await loadMember(user.uid, input.id);
  const m = v.members.find((x) => x.id === input.memberId);
  if (!m) throw new PeopleError("Esa persona no está en la vaquita");
  if (m.uid) throw new PeopleError(`${firstName(m.name)} ya usa la app en esta vaquita`);

  const parsed = parsePersonRef(String(input.ref ?? ""));
  if (!parsed) throw new PeopleError("Persona inválida");
  let uid: string;
  if (parsed.type === "user") {
    uid = parsed.uid;
  } else {
    const c = (await db().doc(`users/${user.uid}/contacts/${parsed.contactId}`).get()).data();
    if (!c) throw new PeopleError("Ese contacto no existe");
    const linked = (c.linkedUid as string | null | undefined) ?? null;
    if (!linked) throw new PeopleError("Todavía no usa la app: cuando se sume y acepte tu solicitud, lo vinculás");
    uid = linked;
  }
  if (uid === user.uid) throw new PeopleError("Ese sos vos");
  if (!(await areConnected(user.uid, uid))) throw new PeopleError("Solo podés vincular a gente con la que estás conectado");
  const p = await loadProfile(uid);
  if (v.uids.includes(uid)) throw new PeopleError(`${profileName(p)} ya está en la vaquita`);

  const members = v.members.map((x) =>
    x.id === m.id ? { ...x, uid, email: p.email || null, name: profileName(p) || x.name, pendingLink: null } : x,
  );
  const patch: Record<string, unknown> = { members, uids: indexUids(members), updatedAt: FieldValue.serverTimestamp() };
  if (!v.categoryByUid?.[uid]) patch[`categoryByUid.${uid}`] = await guessCategory(uid);
  await col().doc(v.id).update(patch);
  await dropPendingLink(v.id, m.id).catch(() => {});

  // Sus asientos: su parte de cada gasto (y los que pagó, para que elija con qué).
  await resyncAllBooks(v.id, [uid]);
  await refreshSummary(v.id);

  const exps = await expensesCol(v.id).get();
  const paidSome = exps.docs.some((d) => ((d.data() as VaquitaExpense).paidBy?.[m.id] ?? 0) > 0);
  const by = firstName(profileName(await loadProfile(user.uid)));
  const extra = paidSome ? " Hay gastos que pagaste vos: entrá y elegí con qué pagaste." : "";
  await notify(uid, {
    kind: "vaquita-invite",
    title: `${by} te vinculó a la vaquita «${v.name}»`,
    body: `Ya estaban tus gastos: ahora la ves en la app y tu parte va a tus cuentas.${extra}`,
    url: `/vaquitas/${v.id}`,
    whatsappText: `🐮 *${by}* te vinculó a la vaquita *${v.name}*: ya estaban tus gastos, ahora la ves en La Libreta y tu parte va a tus cuentas.${extra}`,
  });
  return { name: profileName(p) };
};

/**
 * Vincular por su WhatsApp o su email: si es un contacto, ya; si usa La
 * Libreta, le mando la solicitud y se vincula solo cuando acepta; si no la
 * usa, lo invito (el mail lo manda el server; por WhatsApp lo manda el
 * usuario con el link) y se vincula solo cuando se registra y acepta.
 */
export const linkMemberByQuery = async (
  user: { uid: string },
  input: { id: string; memberId: string; q: string },
): Promise<{ status: "linked" | "requested" | "invited"; name: string }> => {
  const v = await loadMember(user.uid, input.id);
  const m = v.members.find((x) => x.id === input.memberId);
  if (!m) throw new PeopleError("Esa persona no está en la vaquita");
  if (m.uid) throw new PeopleError(`${firstName(m.name)} ya usa la app en esta vaquita`);
  const q = parseContactQuery(String(input.q ?? ""));
  if (!q) throw new PeopleError("Escribí su email o su WhatsApp (con característica)");
  const found = await findUserByQuery(q);
  const mark = (pendingLink: "request" | "invite") =>
    col()
      .doc(v.id)
      .update({
        members: v.members.map((x) => (x.id === m.id ? { ...x, pendingLink } : x)),
        updatedAt: FieldValue.serverTimestamp(),
      });
  if (found) {
    if (found.uid === user.uid) throw new PeopleError("Ese sos vos");
    if (v.uids.includes(found.uid)) throw new PeopleError(`${profileName(found.profile)} ya está en la vaquita`);
    const connected =
      (await areConnected(user.uid, found.uid)) || (await requestConnectionTo(user, found.uid)).status === "accepted";
    if (connected) {
      const r = await linkMember(user, { id: v.id, memberId: m.id, ref: `u:${found.uid}` });
      return { status: "linked", name: r.name };
    }
    await savePendingLink({ vaquitaId: v.id, memberId: m.id, byUid: user.uid, kind: "uid", value: found.uid });
    await mark("request");
    return { status: "requested", name: profileName(found.profile) };
  }
  await savePendingLink({ vaquitaId: v.id, memberId: m.id, byUid: user.uid, kind: q.kind, value: q.value });
  if (q.kind === "email") await sendEmailInvite(user, q.value, m.name).catch(() => {});
  await mark("invite");
  return { status: "invited", name: m.name };
};

/** Sacar a alguien (solo si no tiene gastos ni pagos en la vaquita). */
export const removeMember = async (
  user: { uid: string },
  input: { id: string; memberId: string },
): Promise<void> => {
  const v = await loadMember(user.uid, input.id);
  const m = v.members.find((x) => x.id === input.memberId);
  if (!m) throw new PeopleError("Esa persona no está en la vaquita");
  const [exps, pays] = await Promise.all([expensesCol(v.id).get(), paymentsCol(v.id).get()]);
  const used =
    exps.docs.some((d) => {
      const e = d.data() as VaquitaExpense;
      return (e.paidBy?.[m.id] ?? 0) > 0 || (e.shares?.[m.id] ?? 0) > 0;
    }) ||
    pays.docs.some((d) => {
      const p = d.data() as VaquitaPayment;
      return p.from === m.id || p.to === m.id;
    });
  if (used) throw new PeopleError(`${firstName(m.name)} tiene gastos o pagos en la vaquita: sacalo de esos gastos primero`);
  const members = v.members.filter((x) => x.id !== m.id);
  if (members.length < 1) throw new PeopleError("La vaquita se quedaría sin nadie");
  const uids = indexUids(members);
  if (uids.length === 0) throw new PeopleError("Tiene que quedar al menos alguien con la app");
  await dropPendingLink(v.id, m.id).catch(() => {});
  await col().doc(v.id).update({
    members,
    uids,
    families: v.families.filter((f) => members.some((x) => x.familyId === f.id)),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await refreshSummary(v.id);
};

/**
 * Armar las familias: la lista completa (las que no vienen se borran) y a
 * qué familia va cada integrante. Rehace los asientos de todos los gastos.
 */
export const setFamilies = async (
  user: { uid: string },
  input: { id: string; families: Array<{ id?: string; name: string }>; assignment: Record<string, string | null> },
): Promise<void> => {
  const v = await loadMember(user.uid, input.id);
  const families: VaquitaFamily[] = (input.families ?? [])
    .map((f) => ({ id: String(f.id || newId("f_")), name: cleanName(f.name, 40) }))
    .filter((f) => f.name);
  const famIds = new Set(families.map((f) => f.id));
  const members = v.members.map((m) => {
    const a = input.assignment?.[m.id];
    const familyId = a === undefined ? m.familyId : a;
    return { ...m, familyId: familyId && famIds.has(familyId) ? familyId : null };
  });
  await col().doc(v.id).update({
    members,
    families: families.filter((f) => members.some((m) => m.familyId === f.id)),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await resyncAllBooks(v.id);
  await refreshSummary(v.id);
};

/** Borrar la vaquita (solo quien la creó): se sacan sus asientos de las cuentas de todos. */
export const deleteVaquita = async (user: { uid: string }, input: { id: string }): Promise<void> => {
  const v = await loadMember(user.uid, input.id);
  if (v.createdByUid !== user.uid) throw new PeopleError("Solo quien creó la vaquita la puede borrar");
  const [exps, pays] = await Promise.all([expensesCol(v.id).get(), paymentsCol(v.id).get()]);
  for (const d of exps.docs) {
    await clearExpenseBooks(d.id, (d.data().bookUids as string[] | undefined) ?? v.uids);
    await d.ref.delete();
  }
  for (const d of pays.docs) {
    await clearPaymentBooks(d.id, Object.keys((d.data().legs as Record<string, unknown> | undefined) ?? {}));
    await d.ref.delete();
  }
  const links = await pendingLinksCol().where("vaquitaId", "==", v.id).get();
  for (const d of links.docs) await d.ref.delete();
  await col().doc(v.id).delete();
};

// === Asientos en las cuentas de cada uno ===

type ServerAccountDoc = ServerAccount & { name: string; active?: boolean; currencies?: Currency[] | null };

const loadAccount = async (uid: string, accountId: string): Promise<ServerAccountDoc> => {
  const d = (await db().doc(`users/${uid}/accounts/${accountId}`).get()).data();
  if (!d || d.active === false) throw new PeopleError("Esa cuenta no existe");
  return {
    id: accountId,
    type: d.type as AccountType,
    defaultClosingDay: d.defaultClosingDay as number | undefined,
    defaultDueDay: d.defaultDueDay as number | undefined,
    name: String(d.name ?? ""),
    currencies: (d.currencies as Currency[] | null | undefined) ?? null,
  };
};

/** La cuenta tiene que manejar la moneda (si no, se la agrega; las tarjetas solo pesos y dólares). */
const ensureCurrency = async (uid: string, acc: ServerAccountDoc, currency: Currency) => {
  const list = accountCurrencies(acc);
  if (list.includes(currency)) return;
  if (acc.type === "credit") {
    throw new PeopleError(`Las tarjetas cobran en pesos o dólares: cargá el gasto en una de esas monedas`);
  }
  if (acc.type === "reserve") throw new PeopleError(`"${acc.name}" no maneja ${currencyLabel(currency).toLowerCase()}`);
  await db().doc(`users/${uid}/accounts/${acc.id}`).update({ currencies: [...list, currency] });
};

const deleteTxWithInstallments = async (uid: string, txIds: string[]) => {
  const ins = await db().collection(`users/${uid}/installments`).where("transactionId", "in", txIds).get();
  const batch = db().batch();
  ins.docs.forEach((d) => batch.delete(d.ref));
  for (const id of txIds) batch.delete(db().doc(`users/${uid}/transactions/${id}`));
  await batch.commit();
};

const clearExpenseBooks = async (eid: string, uids: string[]) => {
  for (const uid of new Set(uids)) await deleteTxWithInstallments(uid, [realTxId(eid), partTxId(eid)]);
};

const clearPaymentBooks = async (pid: string, uids: string[]) => {
  for (const uid of new Set(uids)) await deleteTxWithInstallments(uid, [paymentTxId(pid)]);
};

/** Rehace lo que un gasto escribe en las cuentas de cada uno. */
const syncExpenseBooks = async (v: Vaquita, e: VaquitaExpense & { bookUids?: string[] }, only?: string[]) => {
  const entries = computeExpenseBooks(v, e);
  const touched = new Set([...(e.bookUids ?? []), ...entries.map((x) => x.uid)]);
  const scope = only ? [...touched].filter((u) => only.includes(u)) : [...touched];
  await clearExpenseBooks(e.id, scope);

  const date = dateFromYMD(e.date);
  const month = e.date.slice(0, 7);
  const createdAt = e.createdAt instanceof Timestamp ? e.createdAt : Timestamp.now();
  // Los que quedan fuera de `only` no se tocan: siguen como estaban.
  const written: string[] = (e.bookUids ?? []).filter((u) => !scope.includes(u));
  for (const x of entries) {
    if (!scope.includes(x.uid)) continue;
    const categoryId = v.categoryByUid?.[x.uid] ?? "";
    const base = { vaquitaId: v.id, vaquitaExpenseId: e.id };
    if (x.realTx) {
      try {
        const acc = await loadAccount(x.uid, x.realTx.accountId);
        await createTransactionAdmin({
          id: realTxId(e.id),
          ownerUid: x.uid,
          account: acc,
          accountId: acc.id,
          categoryId,
          description: e.description,
          totalAmount: x.realTx.amount,
          purchaseDate: date,
          kind: "expense",
          installments: x.realTx.installments,
          cardClosedAtPurchase: e.legs?.[x.uid]?.cardClosedAtPurchase ?? false,
          // Si vino de un movimiento ya cargado y la fecha no cambió, queda en el mismo resumen.
          forceFirstBillingMonth:
            e.legs?.[x.uid]?.billing?.date === e.date ? e.legs?.[x.uid]?.billing?.month : undefined,
          currency: e.currency,
          extra: { ...base, shareFactor: x.realTx.shareFactor, createdAt },
        });
        if (!written.includes(x.uid)) written.push(x.uid);
      } catch (err) {
        // La cuenta ya no existe: queda como su parte, sin el gasto real.
        console.warn("[vaquitas] no se pudo escribir el gasto real", x.uid, err);
        x.partAmount = x.carried;
      }
    }
    if (x.partAmount >= 0.01) {
      const id = partTxId(e.id);
      const accountId = vaquitaAccountId(v.id);
      const batch = db().batch();
      batch.set(db().doc(`users/${x.uid}/transactions/${id}`), {
        accountId,
        categoryId,
        description: e.description,
        totalAmount: x.partAmount,
        purchaseDate: Timestamp.fromDate(date),
        kind: "expense",
        installments: 1,
        cardClosedAtPurchase: false,
        firstBillingMonth: month,
        currency: e.currency,
        ...base,
        createdAt,
      });
      batch.set(db().doc(`users/${x.uid}/installments/${id}_1`), {
        transactionId: id,
        accountId,
        categoryId,
        amount: x.partAmount,
        billingMonth: month,
        billingDate: Timestamp.fromDate(date),
        paymentMonth: month,
        installmentNumber: 1,
        totalInstallments: 1,
        kind: "expense",
        description: e.description,
        currency: e.currency,
        ...base,
      });
      await batch.commit();
      if (!written.includes(x.uid)) written.push(x.uid);
    }
  }
  await expensesCol(v.id).doc(e.id).update({ bookUids: written });
};

/** Rehace lo que un pago escribe en las cuentas de quien lo mandó y quien lo recibió. */
const syncPaymentBooks = async (v: Vaquita, p: VaquitaPayment, prevUids: string[] = []) => {
  await clearPaymentBooks(p.id, [...prevUids, ...Object.keys(p.legs ?? {})]);
  const byId = new Map(v.members.map((m) => [m.id, m]));
  const from = byId.get(p.from);
  const to = byId.get(p.to);
  const date = dateFromYMD(p.date);
  const month = p.date.slice(0, 7);
  const createdAt = p.createdAt instanceof Timestamp ? p.createdAt : Timestamp.now();
  const counterpart = vaquitaAccountId(v.id);
  for (const [uid, leg] of Object.entries(p.legs ?? {})) {
    const role = from?.uid === uid ? "source" : to?.uid === uid ? "destination" : null;
    if (!role) continue;
    const other = role === "source" ? to : from;
    const description = p.note || `${v.name}: ${role === "source" ? "pago a" : "pago de"} ${firstName(other?.name ?? "alguien")}`;
    const id = paymentTxId(p.id);
    const batch = db().batch();
    batch.set(db().doc(`users/${uid}/transactions/${id}`), {
      accountId: role === "source" ? leg.accountId : counterpart,
      toAccountId: role === "source" ? counterpart : leg.accountId,
      categoryId: "",
      description,
      totalAmount: p.amount,
      purchaseDate: Timestamp.fromDate(date),
      kind: "transfer",
      installments: 1,
      firstBillingMonth: month,
      currency: p.currency,
      transferType: "p2p",
      vaquitaId: v.id,
      vaquitaPaymentId: p.id,
      createdAt,
    });
    batch.set(db().doc(`users/${uid}/installments/${id}`), {
      transactionId: id,
      accountId: leg.accountId,
      categoryId: "",
      amount: p.amount,
      billingMonth: month,
      billingDate: Timestamp.fromDate(date),
      paymentMonth: month,
      installmentNumber: 1,
      totalInstallments: 1,
      kind: "transfer",
      description,
      transferType: "p2p",
      transferRole: role,
      transferCounterpartId: counterpart,
      currency: p.currency,
      vaquitaId: v.id,
      vaquitaPaymentId: p.id,
    });
    await batch.commit();
  }
};

/** Rehace los asientos de todos los gastos (cambió una familia, una categoría…). */
const resyncAllBooks = async (vid: string, only?: string[]) => {
  const v = await loadVaquita(vid);
  const exps = await expensesCol(vid).get();
  for (const d of exps.docs) {
    await syncExpenseBooks(v, { id: d.id, ...(d.data() as Omit<VaquitaExpense, "id">) }, only);
  }
};

/**
 * Guarda en la vaquita el total y el saldo de cada parte (para la lista, sin
 * tener que leer todos los gastos).
 */
const refreshSummary = async (vid: string) => {
  const v = await loadVaquita(vid);
  const [exps, pays] = await Promise.all([expensesCol(vid).get(), paymentsCol(vid).get()]);
  const s = summarizeVaquita(
    v,
    exps.docs.map((d) => ({ id: d.id, ...d.data() }) as VaquitaExpense),
    pays.docs.map((d) => ({ id: d.id, ...d.data() }) as VaquitaPayment),
  );
  await col().doc(vid).update({
    summary: {
      total: s.total,
      netByUnit: Object.fromEntries(s.units.map((u) => [u.id, u.net])),
      expenses: exps.size,
      lastDate: exps.docs.map((d) => String(d.data().date ?? "")).sort().pop() ?? null,
    },
    updatedAt: FieldValue.serverTimestamp(),
  });
};

// === Gastos ===

export interface ExpenseInput {
  vaquitaId: string;
  /** Para editar uno que ya existe. */
  expenseId?: string;
  description: string;
  date?: string;
  amount: number;
  currency: Currency;
  /** Cotización a mano (moneda de la vaquita por 1 de `currency`). */
  rate?: number | null;
  paidBy: Record<string, number>;
  splitMode: VaquitaSplitMode;
  splitAmong: string[];
  amounts?: Record<string, number>;
  shareInFamily?: boolean;
  /** Con qué pagué yo (si estoy entre los que pagaron). null = no lo registro en mis cuentas. */
  myLeg?: VaquitaLeg | null;
  /**
   * Pasar a la vaquita un gasto mío ya cargado (users/{uid}/transactions/{id}).
   * Solo al crear: el gasto queda con esa cuenta y cuotas, y el movimiento
   * original se reemplaza por el de la vaquita (no se duplica).
   */
  fromTransactionId?: string;
}

/** Un gasto mío ya cargado que se puede pasar a una vaquita. */
const loadMovableTx = async (uid: string, txId: string) => {
  if (typeof txId !== "string" || !txId || txId.includes("/")) throw new PeopleError("Falta el movimiento");
  const snap = await db().doc(`users/${uid}/transactions/${txId}`).get();
  const t = snap.data();
  if (!t) throw new PeopleError("Ese movimiento ya no existe", 404);
  if (t.kind !== "expense" || t.transferType || t.toAccountId) throw new PeopleError("Solo se pueden pasar gastos");
  if (t.vaquitaId) throw new PeopleError("Ese gasto ya es de una vaquita");
  if (t.splitId || t.p2pTransferId) throw new PeopleError("Ese gasto es parte de un reparto: no se puede pasar");
  if (t.recurringId) throw new PeopleError("Los gastos fijos no se pueden pasar a una vaquita");
  if (t.createdByUid && t.createdByUid !== uid) throw new PeopleError("Ese gasto lo cargó otra persona");
  const accountId = String(t.accountId ?? "");
  if (!accountId || isVirtualAccountId(accountId)) throw new PeopleError("Ese gasto no salió de una cuenta tuya");
  const split = await db().collection("splits").where("ownerTxId", "==", snap.id).limit(5).get();
  if (split.docs.some((d) => d.data().ownerUid === uid && d.data().status === "active")) {
    throw new PeopleError("Ese gasto está dividido con otras personas: cancelá el reparto antes de pasarlo a una vaquita");
  }
  return {
    id: snap.id,
    accountId,
    installments: Math.max(1, Number(t.installments) || 1),
    cardClosedAtPurchase: !!t.cardClosedAtPurchase,
    firstBillingMonth: typeof t.firstBillingMonth === "string" ? t.firstBillingMonth : null,
    date: t.purchaseDate instanceof Timestamp ? todayYMD(t.purchaseDate.toDate()) : null,
    amount: round2(Number(t.totalAmount) || 0),
    currency: (isCurrency(t.currency) ? t.currency : "ARS") as Currency,
  };
};

export const saveExpense = async (user: { uid: string }, input: ExpenseInput): Promise<{ id: string }> => {
  const v = await loadMember(user.uid, input.vaquitaId);
  if (v.status === "closed" && !input.expenseId) throw new PeopleError("La vaquita está cerrada: abrila para cargar gastos");
  const description = cleanName(input.description, 80) || "Gasto";
  if (!isCurrency(input.currency)) throw new PeopleError("Moneda inválida");
  const amount = round2(Number(input.amount));
  if (!(amount > 0)) throw new PeopleError("Ingresá un monto");
  const date = input.date && isYMD(input.date) ? input.date : todayYMD();
  const mode: VaquitaSplitMode = ["people", "families", "amounts"].includes(input.splitMode) ? input.splitMode : "people";

  const paid = checkPaidBy(v, amount, input.paidBy ?? {});
  if (paid.error) throw new PeopleError(paid.error);
  const me = memberOf(v, user.uid);

  // Pasar un gasto ya cargado: pagué yo, con esa cuenta y esas cuotas.
  const fromTx = input.fromTransactionId && !input.expenseId ? await loadMovableTx(user.uid, input.fromTransactionId) : null;
  if (fromTx) {
    if (!me || !((paid.paidBy[me.id] ?? 0) > 0)) throw new PeopleError("Para pasar tu gasto tenés que estar entre los que pagaron");
    // Lo que sale de la cuenta tiene que seguir siendo lo mismo.
    if (input.currency !== fromTx.currency || Math.abs((paid.paidBy[me.id] ?? 0) - fromTx.amount) >= 0.01) {
      throw new PeopleError(`Lo que pagaste tiene que ser lo del movimiento: ${formatMoney(fromTx.amount, fromTx.currency)}`);
    }
  }
  const myLeg: VaquitaLeg | null | undefined = fromTx
    ? {
        accountId: fromTx.accountId,
        installments: fromTx.installments,
        cardClosedAtPurchase: fromTx.cardClosedAtPurchase,
        // Mismo resumen que tenía, salvo que le cambie la fecha.
        ...(fromTx.firstBillingMonth && fromTx.date ? { billing: { date: fromTx.date, month: fromTx.firstBillingMonth } } : {}),
      }
    : input.myLeg;
  const sh = computeShares(v, { amount, splitMode: mode, splitAmong: input.splitAmong ?? [], amounts: input.amounts });
  if (sh.error) throw new PeopleError(sh.error);
  const rate = await resolveRate(input.currency, v.currency, date, input.rate);

  const ref = input.expenseId ? expensesCol(v.id).doc(input.expenseId) : expensesCol(v.id).doc();
  const prevSnap = input.expenseId ? await ref.get() : null;
  if (input.expenseId && !prevSnap?.exists) throw new PeopleError("Ese gasto ya no existe", 404);
  const prev = prevSnap?.exists ? ({ id: ref.id, ...prevSnap.data() } as VaquitaExpense & { bookUids?: string[] }) : null;

  // Cuentas con las que pagó cada uno: cada uno elige la suya. Si dejó de
  // estar entre los que pagaron, se saca.
  const legs: Record<string, VaquitaLeg> = {};
  for (const [uid, leg] of Object.entries(prev?.legs ?? {})) {
    const m = memberOf(v, uid);
    if (m && (paid.paidBy[m.id] ?? 0) > 0) legs[uid] = leg;
  }
  if (myLeg !== undefined && me) {
    if (myLeg && (paid.paidBy[me.id] ?? 0) > 0) {
      if (!myLeg.accountId) throw new PeopleError("Elegí con qué pagaste");
      const acc = await loadAccount(user.uid, myLeg.accountId);
      await ensureCurrency(user.uid, acc, input.currency);
      const installments = acc.type === "credit" ? Math.min(60, Math.max(1, Math.round(myLeg.installments || 1))) : 1;
      // Si sigue en la misma tarjeta, conserva el "resumen ya cerrado" que traía.
      const prevLeg = legs[user.uid];
      const closed =
        acc.type === "credit" &&
        (myLeg.cardClosedAtPurchase ?? (prevLeg?.accountId === acc.id ? prevLeg.cardClosedAtPurchase : false));
      // Y el resumen al que ya estaba asignado (si vino de un movimiento), mientras siga en esa tarjeta.
      const billing = fromTx ? myLeg.billing : prevLeg?.accountId === acc.id ? prevLeg.billing : undefined;
      legs[user.uid] = {
        accountId: acc.id,
        installments,
        ...(closed ? { cardClosedAtPurchase: true } : {}),
        ...(acc.type === "credit" && billing ? { billing } : {}),
      };
    } else {
      delete legs[user.uid];
    }
  }

  const myName = me?.name ?? profileName(await loadProfile(user.uid));
  const data = {
    description,
    date,
    amount,
    currency: input.currency,
    rate,
    paidBy: paid.paidBy,
    splitMode: mode,
    splitAmong: mode === "amounts" ? Object.keys(sh.shares) : (input.splitAmong ?? []),
    shares: sh.shares,
    shareInFamily: !!input.shareInFamily,
    legs,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (prev) {
    await ref.update(data);
  } else {
    await ref.set({
      ...data,
      createdByUid: user.uid,
      createdByName: myName,
      createdAt: FieldValue.serverTimestamp(),
      bookUids: [],
    });
  }
  const fresh = await ref.get();
  await syncExpenseBooks(v, { id: ref.id, ...(fresh.data() as Omit<VaquitaExpense, "id">), bookUids: prev?.bookUids ?? [] });
  await refreshSummary(v.id);

  // El movimiento original se borra solo si el de la vaquita quedó escrito en
  // la misma cuenta: nunca se pierde el cargo real.
  if (fromTx) {
    const real = (await db().doc(`users/${user.uid}/transactions/${realTxId(ref.id)}`).get()).data();
    if (real?.accountId !== fromTx.accountId) {
      throw new PeopleError("Quedó en la vaquita, pero no pude reemplazar tu movimiento: borralo a mano para no duplicarlo");
    }
    await deleteTxWithInstallments(user.uid, [fromTx.id]);
  }
  return { id: ref.id };
};

export const deleteExpense = async (user: { uid: string }, input: { vaquitaId: string; expenseId: string }): Promise<void> => {
  const v = await loadMember(user.uid, input.vaquitaId);
  const ref = expensesCol(v.id).doc(input.expenseId);
  const snap = await ref.get();
  if (!snap.exists) return;
  await clearExpenseBooks(snap.id, [...((snap.data()?.bookUids as string[] | undefined) ?? []), ...v.uids]);
  await ref.delete();
  await refreshSummary(v.id);
};

// === Pagos para saldar ===

export interface PaymentInput {
  vaquitaId: string;
  paymentId?: string;
  from: string;
  to: string;
  amount: number;
  currency: Currency;
  rate?: number | null;
  date?: string;
  note?: string;
  /** Mi cuenta (si soy quien mandó o quien recibió). null = no lo registro. */
  myAccountId?: string | null;
}

export const savePayment = async (user: { uid: string }, input: PaymentInput): Promise<{ id: string }> => {
  const v = await loadMember(user.uid, input.vaquitaId);
  const byId = new Map(v.members.map((m) => [m.id, m]));
  const from = byId.get(input.from);
  const to = byId.get(input.to);
  if (!from || !to) throw new PeopleError("Elegí quién pagó y a quién");
  if (from.id === to.id) throw new PeopleError("Tienen que ser dos personas distintas");
  if (!isCurrency(input.currency)) throw new PeopleError("Moneda inválida");
  const amount = round2(Number(input.amount));
  if (!(amount > 0)) throw new PeopleError("Ingresá un monto");
  const date = input.date && isYMD(input.date) ? input.date : todayYMD();
  const rate = await resolveRate(input.currency, v.currency, date, input.rate);

  const ref = input.paymentId ? paymentsCol(v.id).doc(input.paymentId) : paymentsCol(v.id).doc();
  const prevSnap = input.paymentId ? await ref.get() : null;
  if (input.paymentId && !prevSnap?.exists) throw new PeopleError("Ese pago ya no existe", 404);
  const prev = prevSnap?.exists ? ({ id: ref.id, ...prevSnap.data() } as VaquitaPayment) : null;

  const legs: Record<string, { accountId: string }> = {};
  for (const [uid, leg] of Object.entries(prev?.legs ?? {})) {
    if (uid === from.uid || uid === to.uid) legs[uid] = leg;
  }
  const iAmParty = from.uid === user.uid || to.uid === user.uid;
  if (input.myAccountId !== undefined && iAmParty) {
    if (input.myAccountId) {
      const acc = await loadAccount(user.uid, input.myAccountId);
      if (acc.type === "credit") throw new PeopleError("Elegí una cuenta (no una tarjeta)");
      await ensureCurrency(user.uid, acc, input.currency);
      legs[user.uid] = { accountId: acc.id };
    } else delete legs[user.uid];
  }

  const data = {
    from: from.id,
    to: to.id,
    amount,
    currency: input.currency,
    rate,
    date,
    note: cleanName(input.note, 80),
    legs,
  };
  if (prev) await ref.update(data);
  else await ref.set({ ...data, createdByUid: user.uid, createdAt: FieldValue.serverTimestamp() });
  const fresh = { id: ref.id, ...((await ref.get()).data() as Omit<VaquitaPayment, "id">) };
  await syncPaymentBooks(v, fresh, Object.keys(prev?.legs ?? {}));
  await refreshSummary(v.id);

  // Aviso a la otra punta (si usa la app y no es quien lo cargó).
  if (!prev) {
    const myName = memberOf(v, user.uid)?.name ?? "Alguien";
    for (const m of [from, to]) {
      if (!m.uid || m.uid === user.uid) continue;
      const other = m.id === from.id ? to : from;
      const text =
        m.id === to.id
          ? `${firstName(other.name)} te pagó ${formatMoney(amount, input.currency)}`
          : `Le pagaste ${formatMoney(amount, input.currency)} a ${firstName(other.name)}`;
      await notify(m.uid, {
        kind: "vaquita-payment",
        title: `${v.name}: ${text}`,
        body: `Lo anotó ${firstName(myName)}. Elegí en qué cuenta ${m.id === to.id ? "entró" : "salió"} para que quede en tus cuentas.`,
        url: `/vaquitas/${v.id}`,
        whatsappText: `🐮 *${v.name}*: ${text}. Entrá a La Libreta para elegir la cuenta.`,
      });
    }
  }
  return { id: ref.id };
};

export const deletePayment = async (user: { uid: string }, input: { vaquitaId: string; paymentId: string }): Promise<void> => {
  const v = await loadMember(user.uid, input.vaquitaId);
  const ref = paymentsCol(v.id).doc(input.paymentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  await clearPaymentBooks(snap.id, Object.keys((snap.data()?.legs as Record<string, unknown> | undefined) ?? {}));
  await ref.delete();
  await refreshSummary(v.id);
};

// === Lecturas (agente) ===

/** Vaquitas donde participa un usuario. */
export const loadVaquitasFor = async (uid: string): Promise<Vaquita[]> =>
  (await col().where("uids", "array-contains", uid).get()).docs.map(toVaquita);

const millis = (t: unknown) => (t instanceof Timestamp ? t.toMillis() : 0);

/** Las abiertas, de la que se movió más reciente a la más vieja (para el agente). Si falla, ninguna. */
export const loadOpenVaquitas = async (uid: string, max = 5): Promise<Vaquita[]> => {
  try {
    return (await loadVaquitasFor(uid))
      .filter((v) => v.status !== "closed")
      .sort((a, b) => millis(b.updatedAt ?? b.createdAt) - millis(a.updatedAt ?? a.createdAt))
      .slice(0, max);
  } catch (err) {
    console.warn("[vaquitas] no se pudieron cargar para el agente", err);
    return [];
  }
};

/** Gastos y pagos de una vaquita (los gastos, del más nuevo al más viejo). */
export const loadVaquitaMovements = async (
  vid: string,
): Promise<{ expenses: VaquitaExpense[]; payments: VaquitaPayment[] }> => {
  const [exps, pays] = await Promise.all([expensesCol(vid).get(), paymentsCol(vid).get()]);
  const expenses = exps.docs
    .map((d) => ({ id: d.id, ...d.data() }) as VaquitaExpense)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt?.toDate?.().getTime() ?? 0) - (a.createdAt?.toDate?.().getTime() ?? 0));
  const payments = pays.docs.map((d) => ({ id: d.id, ...d.data() }) as VaquitaPayment).sort((a, b) => b.date.localeCompare(a.date));
  return { expenses, payments };
};
