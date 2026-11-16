import type { Currency } from "./types";

/**
 * Cuentas con gente: conexiones entre usuarios, gastos repartidos y
 * transferencias entre personas. Tipos y helpers puros (los usan la web, el
 * server y el agente).
 *
 * Una persona se identifica con un PersonRef:
 * - "u:<uid>": otro usuario de la app (con una conexión aceptada).
 * - "c:<contactId>": un contacto sin la app (users/{yo}/contacts/{id}).
 */
export type PersonRef = `u:${string}` | `c:${string}`;

export const userRef = (uid: string): PersonRef => `u:${uid}`;
export const contactRef = (contactId: string): PersonRef => `c:${contactId}`;

export const parsePersonRef = (
  ref: string,
): { type: "user"; uid: string } | { type: "contact"; contactId: string } | null => {
  if (ref.startsWith("u:") && ref.length > 2) return { type: "user", uid: ref.slice(2) };
  if (ref.startsWith("c:") && ref.length > 2) return { type: "contact", contactId: ref.slice(2) };
  return null;
};

/**
 * "Cuenta" de una persona: la usan los asientos que no mueven plata de una
 * cuenta propia (la parte de un gasto que pagó otro, que le debo) y la
 * contraparte de una transferencia con una persona. computeAccountBalances
 * las ignora porque no son cuentas reales.
 */
export const personAccountId = (ref: PersonRef) => `person:${ref}`;
export const isPersonAccountId = (id: string | null | undefined): boolean => !!id?.startsWith("person:");
export const personRefFromAccountId = (id: string | null | undefined): PersonRef | null =>
  id && id.startsWith("person:") ? (id.slice("person:".length) as PersonRef) : null;

/** Id del doc de una conexión: los dos uids ordenados. */
export const pairId = (a: string, b: string) => [a, b].sort().join("_");

const round2 = (n: number) => Math.round(n * 100) / 100;

// === Conexiones ===

export type ConnectionStatus = "pending" | "accepted" | "rejected" | "removed";

export interface ConnectionProfile {
  email: string;
  displayName: string | null;
  photoURL: string | null;
}

/** connections/{pairId} — solo la escribe el server. */
export interface Connection {
  id: string;
  uids: string[];
  requesterUid: string;
  addresseeUid: string;
  status: ConnectionStatus;
  profiles: Record<string, ConnectionProfile>;
  createdAt?: { toDate(): Date } | null;
  respondedAt?: { toDate(): Date } | null;
}

export const otherUid = (c: Pick<Connection, "uids">, me: string) => c.uids.find((u) => u !== me) ?? me;

export const profileName = (p: ConnectionProfile | undefined | null, fallback = "Alguien") =>
  p?.displayName?.trim() || p?.email?.split("@")[0] || fallback;

// === Gastos repartidos ===

export type SplitMode = "installments" | "lump";
export type SplitParticipantStatus = "pending" | "accepted" | "rejected" | "offline";

export interface SplitScheduleEntry {
  /** Mes en que se paga (YYYY-MM). */
  paymentMonth: string;
  /** YYYY-MM-DD de esa cuota (vencimiento si es tarjeta). */
  date: string;
  amount: number;
}

export interface SplitParticipant {
  ref: PersonRef;
  uid: string | null;
  contactId: string | null;
  /** Nombre al momento de repartir (por si después se borra el contacto). */
  name: string;
  email: string | null;
  shareType: "percent" | "amount";
  percent: number | null;
  /** Su parte del total (redondeada). */
  amount: number;
  /** offline = contacto sin la app: no hay nada que aceptar. */
  status: SplitParticipantStatus;
  respondedAt?: { toDate(): Date } | null;
  rejectReason?: string | null;
  /** Si lo sumó a sus gastos (con su categoría). */
  addToBooks: boolean;
  categoryId: string | null;
  participantTxId: string | null;
}

/** splits/{id} — solo lo escribe el server. */
export interface Split {
  id: string;
  ownerUid: string;
  ownerName: string;
  ownerEmail: string | null;
  /** Gasto del dueño (users/{owner}/transactions/{ownerTxId}). */
  ownerTxId: string;
  ownerAccountName?: string | null;
  description: string;
  /** YYYY-MM-DD de la compra. */
  date: string;
  currency: Currency;
  totalAmount: number;
  installments: number;
  /** Cuotas del dueño (copiadas de su gasto): de acá salen los meses. */
  schedule: SplitScheduleEntry[];
  /** "Me lo paga en cuotas" o "todo junto". */
  mode: SplitMode;
  participants: SplitParticipant[];
  /** Dueño + participantes con la app (reglas y consultas). */
  uids: string[];
  status: "active" | "cancelled";
  createdAt?: { toDate(): Date } | null;
  updatedAt?: { toDate(): Date } | null;
}

export interface ShareInput {
  shareType: "percent" | "amount";
  /** % (0-100) o monto. */
  value: number;
}

/**
 * Partes de cada persona a partir de % o montos. El resto del redondeo de
 * los % va a la última parte en %, así nunca suman más que el total.
 */
export const computeShares = (
  total: number,
  inputs: ShareInput[],
): { amounts: number[]; error: string | null } => {
  const amounts = inputs.map((i) => round2(i.shareType === "percent" ? (total * i.value) / 100 : i.value));
  if (inputs.some((i) => !(i.value > 0))) return { amounts, error: "Cada parte tiene que ser mayor a 0" };
  if (inputs.some((i) => i.shareType === "percent" && i.value > 100)) {
    return { amounts, error: "Un porcentaje no puede pasar de 100" };
  }
  const sum = round2(amounts.reduce((s, a) => s + a, 0));
  if (sum > total + 0.009) return { amounts, error: "Las partes suman más que el gasto" };
  return { amounts, error: null };
};

/** Lo que le toca pagar a una persona y en qué mes. */
export const participantSchedule = (
  split: Pick<Split, "schedule" | "mode" | "totalAmount">,
  amount: number,
): SplitScheduleEntry[] => {
  const sched = [...split.schedule].sort((a, b) => a.paymentMonth.localeCompare(b.paymentMonth));
  if (sched.length === 0) return [];
  if (split.mode === "lump" || sched.length === 1) {
    return [{ paymentMonth: sched[0].paymentMonth, date: sched[0].date, amount: round2(amount) }];
  }
  const out: SplitScheduleEntry[] = [];
  let used = 0;
  sched.forEach((s, i) => {
    const part =
      i === sched.length - 1
        ? round2(amount - used)
        : round2(split.totalAmount > 0 ? (amount * s.amount) / split.totalAmount : amount / sched.length);
    used = round2(used + part);
    out.push({ paymentMonth: s.paymentMonth, date: s.date, amount: part });
  });
  return out;
};

// === Transferencias entre personas ===

export type PersonTransferStatus = "pending" | "accepted" | "rejected" | "cancelled" | "voided";

/** p2pTransfers/{id} — solo lo escribe el server. */
export interface PersonTransfer {
  id: string;
  /** Usuarios de la app involucrados (1 si la otra persona no usa la app). */
  uids: string[];
  createdByUid: string;
  /** De quién a quién va la plata. */
  from: PersonRef;
  to: PersonRef;
  fromName: string;
  toName: string;
  amount: number;
  currency: Currency;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** "loan" = préstamo (solo cambia cómo se muestra). */
  kind: "payment" | "loan";
  status: PersonTransferStatus;
  /** Lo que se registró en las cuentas de cada usuario. */
  legs: Record<string, { accountId: string | null; txId: string | null }>;
  /** Contacto sin app: dueño del contacto (para resolver el nombre). */
  contactOwnerUid?: string | null;
  createdAt?: { toDate(): Date } | null;
  respondedAt?: { toDate(): Date } | null;
}

/** Del punto de vista de `me`: la otra persona y si la plata salió o entró. */
export const transferSide = (
  t: Pick<PersonTransfer, "from" | "to" | "fromName" | "toName">,
  me: string,
): { person: PersonRef; name: string; direction: "out" | "in" } | null => {
  const mine = userRef(me);
  if (t.from === mine) return { person: t.to, name: t.toName, direction: "out" };
  if (t.to === mine) return { person: t.from, name: t.fromName, direction: "in" };
  return null;
};
