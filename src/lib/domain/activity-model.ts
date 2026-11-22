import type { Timestamp } from "firebase/firestore";
import type { Currency } from "./types";

/**
 * Agenda: actividades con fecha (y opcionalmente hora). Viven en una colección
 * de primer nivel para poder compartirlas: el dueño invita gente y cada
 * invitado la ve en su agenda cuando acepta. Si la actividad tiene un gasto,
 * cada uno puede cargarlo y queda vinculado en `expenses[uid]`.
 */
export const activitiesCollectionPath = (): string => "activities";

/**
 * Índice inverso gasto → actividad en la libreta de quien lo cargó:
 * `users/{uid}/activityLinks/{transactionId}`. Si el gasto se edita o se borra
 * desde Movimientos, la actividad se actualiza (ver syncActivityLinkForTransaction).
 */
export const activityLinksCollectionPath = (uid: string): string => `users/${uid}/activityLinks`;

export interface ActivityLink {
  activityId: string;
  /** epoch ms */
  createdAt: number;
}

export type ActivityParticipantStatus = "owner" | "pending" | "accepted" | "rejected";

export interface ActivityParticipant {
  uid: string | null;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
  status: ActivityParticipantStatus;
}

/** Gasto que cargó alguien para esta actividad (va en su libreta, con su cuenta). */
export interface ActivityExpense {
  transactionId: string;
  amount: number;
  currency: Currency;
  byName?: string | null;
  /** Si lo dividió con los demás (gasto compartido). */
  sharedExpenseId?: string | null;
  createdAt: Timestamp;
}

export interface Activity {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName?: string | null;
  title: string;
  /** Día en hora argentina, "YYYY-MM-DD". */
  date: string;
  /** "HH:mm" o null si es todo el día. */
  time?: string | null;
  location?: string | null;
  notes?: string | null;
  /** Lo que se calcula que va a salir (sirve para precargar el gasto). */
  estimatedAmount?: number | null;
  currency?: Currency | null;
  /** Incluye al dueño (status "owner"). */
  participants: ActivityParticipant[];
  participantUids: string[];
  participantEmails: string[];
  /** Gastos cargados, por uid de quien lo cargó. */
  expenses?: Record<string, ActivityExpense>;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export interface ActivityInput {
  title: string;
  date: string;
  time?: string | null;
  location?: string | null;
  notes?: string | null;
  estimatedAmount?: number | null;
  currency?: Currency | null;
}

export interface Invitee {
  uid: string | null;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
}

const clean = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

/** Campos para consultar por uid o email (incluyen al dueño). */
export const activityIndexFields = (participants: ActivityParticipant[]) => ({
  participantUids: Array.from(
    new Set(participants.map((p) => p.uid).filter((u): u is string => !!u)),
  ),
  participantEmails: Array.from(new Set(participants.map((p) => p.email.toLowerCase()).filter(Boolean))),
});

/** Normaliza lo que carga el usuario (sin vacíos; sin moneda si no hay monto). */
export const activityBaseFields = (input: ActivityInput) => ({
  title: input.title.trim(),
  date: input.date,
  time: clean(input.time),
  location: clean(input.location),
  notes: clean(input.notes),
  estimatedAmount: input.estimatedAmount && input.estimatedAmount > 0 ? input.estimatedAmount : null,
  currency: input.estimatedAmount && input.estimatedAmount > 0 ? (input.currency ?? "ARS") : null,
});

/**
 * Arma la lista de participantes nueva conservando el estado de los que ya
 * estaban (si aceptaron, siguen aceptados). Devuelve también los emails nuevos
 * para mandarles la invitación.
 */
export const mergeParticipants = (
  owner: Invitee,
  previous: ActivityParticipant[],
  invitees: Invitee[],
): { participants: ActivityParticipant[]; added: string[] } => {
  const ownerEmail = owner.email.toLowerCase();
  const byEmail = new Map(previous.map((p) => [p.email.toLowerCase(), p]));
  const added: string[] = [];
  const others: ActivityParticipant[] = [];
  const seen = new Set<string>([ownerEmail]);
  for (const inv of invitees) {
    const email = inv.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const prev = byEmail.get(email);
    if (prev && prev.status !== "owner") {
      others.push({ ...prev, uid: prev.uid ?? inv.uid ?? null });
    } else {
      added.push(email);
      others.push({
        uid: inv.uid ?? null,
        email,
        displayName: inv.displayName ?? null,
        photoURL: inv.photoURL ?? null,
        status: "pending",
      });
    }
  }
  return {
    participants: [
      {
        uid: owner.uid,
        email: ownerEmail,
        displayName: owner.displayName ?? null,
        photoURL: owner.photoURL ?? null,
        status: "owner",
      },
      ...others,
    ],
    added,
  };
};

// === Helpers de vista ===

/** Mi lugar en la actividad (por uid o, si todavía no tenía cuenta, por email). */
export const myParticipation = (
  a: Activity,
  me: { uid: string; email?: string | null },
): ActivityParticipant | null => {
  const email = me.email?.toLowerCase();
  return (
    a.participants.find((p) => p.uid === me.uid) ??
    (email ? a.participants.find((p) => !p.uid && p.email.toLowerCase() === email) : undefined) ??
    null
  );
};

export const participantName = (p: { displayName?: string | null; email: string }) =>
  p.displayName?.trim() || p.email.split("@")[0];

/** Los demás que van (o están invitados), sin mí y sin los que dijeron que no. */
export const companions = (a: Activity, me: { uid: string | null; email?: string | null }) => {
  const email = me.email?.toLowerCase();
  return a.participants.filter(
    (p) => !(me.uid && p.uid === me.uid) && !(email && p.email.toLowerCase() === email) && p.status !== "rejected",
  );
};

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" de hoy (o de la fecha dada) en Argentina. */
export const ymdAR = (d = new Date()): string => ymdFormatter.format(d);

export const addDaysYMD = (ymd: string, days: number): string =>
  ymdAR(new Date(new Date(`${ymd}T12:00:00-03:00`).getTime() + days * 86_400_000));

const dayLabelFormatter = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "Hoy", "Mañana", "Ayer" o "sábado 22 de noviembre". */
export const dayLabel = (ymd: string, today = ymdAR()): string => {
  if (ymd === today) return "Hoy";
  if (ymd === addDaysYMD(today, 1)) return "Mañana";
  if (ymd === addDaysYMD(today, -1)) return "Ayer";
  const s = dayLabelFormatter.format(new Date(`${ymd}T12:00:00-03:00`)).replace(",", "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Orden de la agenda: por día y, dentro del día, primero las de todo el día y después por hora. */
export const compareActivities = (a: Activity, b: Activity) =>
  a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.title.localeCompare(b.title);
