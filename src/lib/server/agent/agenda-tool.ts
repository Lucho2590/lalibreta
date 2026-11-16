import "server-only";

import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { adminDb } from "../firebase-admin";
import { isYMD, todayYMD } from "../time";
import {
  ActivityError,
  cancelActivityAdmin,
  createActivityAdmin,
  updateActivityAdmin,
  listAgenda,
  respondToActivity,
  whenText,
} from "../activities";
import { addDaysYMD, dayLabel, participantName, type Activity, type Invitee } from "@/lib/domain/activity-model";
import { formatMoney } from "@/lib/format";

/** Agenda por WhatsApp: anotar actividades (y con quién), consultar qué hay y responder invitaciones. */
export const AGENDA_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "add_activity",
      description:
        "Anota una actividad en la agenda del usuario (turno, salida, cumpleaños, viaje…). Se guarda directo. Si es con otras personas, se las invita (les llega un aviso) y si aceptan la ven en su agenda.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: 'Qué es, corto ("Cena con los chicos", "Turno dentista")' },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:mm (24 h). Omitir si no dijo hora" },
          location: { type: "string", description: "Dónde (opcional)" },
          notes: { type: "string", description: "Notas (opcional)" },
          estimatedAmount: { type: "number", description: "Si dijo cuánto va a salir (opcional)" },
          currency: { type: "string", enum: ["ARS", "USD"] },
          people: {
            type: "array",
            items: { type: "string" },
            description:
              "Con quién: nombres de sus contactos de la app o emails. Solo si quiere compartirla/invitarlos.",
          },
        },
        required: ["title", "date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agenda",
      description:
        "Lo que el usuario tiene en la agenda entre dos fechas (las suyas, las compartidas que aceptó y las invitaciones sin responder).",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD, por defecto hoy" },
          to: { type: "string", description: "YYYY-MM-DD, por defecto 7 días después de from" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "respond_activity",
      description: "Responde una invitación a una actividad (va o no va), o se baja de una que había aceptado.",
      parameters: {
        type: "object",
        properties: {
          activityId: { type: "string", description: "id que devolvió get_agenda" },
          going: { type: "boolean" },
        },
        required: ["activityId", "going"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_activity",
      description:
        "Cambia una actividad que organiza el usuario (día, hora, lugar, nombre). Se guarda directo y a los invitados les llega un aviso con lo que cambió. Pasá solo lo que cambia.",
      parameters: {
        type: "object",
        properties: {
          activityId: { type: "string", description: "id que devolvió get_agenda" },
          title: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:mm (24 h)" },
          allDay: { type: "boolean", description: "true para sacarle la hora (todo el día)" },
          location: { type: "string" },
        },
        required: ["activityId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_activity",
      description:
        "Cancela (borra) una actividad que organiza el usuario. A los invitados les llega un aviso de que se canceló. Si la actividad es de otro, no se puede: usá respond_activity con going=false.",
      parameters: {
        type: "object",
        properties: { activityId: { type: "string", description: "id que devolvió get_agenda" } },
        required: ["activityId"],
        additionalProperties: false,
      },
    },
  },
];

export const AGENDA_TOOL_NAMES = new Set(AGENDA_TOOLS.map((t) => t.function.name));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const addSchema = z.object({
  title: z.string().trim().min(1).max(120),
  date: z.string().refine(isYMD, "date debe ser YYYY-MM-DD"),
  time: optStr.refine((v) => !v || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), "time debe ser HH:mm"),
  location: optStr,
  notes: optStr,
  estimatedAmount: z.number().positive().max(1_000_000_000).optional(),
  currency: z.enum(["ARS", "USD"]).optional(),
  people: z.array(z.string()).max(20).optional(),
});

const agendaSchema = z.object({
  from: optStr.refine((v) => !v || isYMD(v), "from debe ser YYYY-MM-DD"),
  to: optStr.refine((v) => !v || isYMD(v), "to debe ser YYYY-MM-DD"),
});

const respondSchema = z.object({ activityId: z.string().min(1), going: z.boolean() });

const updateSchema = z.object({
  activityId: z.string().min(1),
  title: optStr,
  date: optStr.refine((v) => !v || isYMD(v), "date debe ser YYYY-MM-DD"),
  time: optStr.refine((v) => !v || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), "time debe ser HH:mm"),
  allDay: z.boolean().optional(),
  location: optStr,
});

const cancelSchema = z.object({ activityId: z.string().min(1) });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

const loadMe = async (uid: string) => {
  const d = (await adminDb().collection("users").doc(uid).get()).data() ?? {};
  return {
    uid,
    email: ((d.email as string | undefined) ?? "").toLowerCase(),
    displayName: (d.displayName as string | undefined) ?? null,
    photoURL: (d.photoURL as string | undefined) ?? null,
  };
};

/** Resuelve "Orne", "juan@x.com"… contra los contactos del usuario. */
const resolvePeople = async (
  uid: string,
  people: string[],
): Promise<{ ok: Invitee[] } | { error: string }> => {
  if (people.length === 0) return { ok: [] };
  const snap = await adminDb().collection(`users/${uid}/contacts`).get();
  const contacts = snap.docs.map((d) => d.data() as { email: string; displayName?: string | null; linkedUid?: string | null; photoURL?: string | null });
  const out: Invitee[] = [];
  for (const raw of people) {
    const q = raw.trim();
    if (!q) continue;
    if (EMAIL_RE.test(q)) {
      const email = q.toLowerCase();
      const c = contacts.find((x) => x.email.toLowerCase() === email);
      let found = c?.linkedUid ?? null;
      if (!found) {
        const u = await adminDb().collection("users").where("email", "==", email).limit(1).get();
        found = u.docs[0]?.id ?? null;
      }
      out.push({ uid: found, email, displayName: c?.displayName ?? null, photoURL: c?.photoURL ?? null });
      continue;
    }
    const n = norm(q);
    const exact = contacts.filter((c) => c.displayName && norm(c.displayName) === n);
    const partial = contacts.filter(
      (c) =>
        (c.displayName && norm(c.displayName).split(/\s+/).some((w) => w === n)) ||
        (c.displayName && norm(c.displayName).includes(n)) ||
        norm(c.email.split("@")[0]).includes(n),
    );
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 1) {
      const c = matches[0];
      out.push({ uid: c.linkedUid ?? null, email: c.email.toLowerCase(), displayName: c.displayName ?? null, photoURL: c.photoURL ?? null });
    } else if (matches.length > 1) {
      return {
        error: `"${q}" coincide con varios contactos: ${matches.map((c) => c.displayName || c.email).join(", ")}. Preguntale cuál.`,
      };
    } else {
      const names = contacts.map((c) => c.displayName || c.email);
      return {
        error: `"${q}" no está en sus contactos${names.length ? ` (tiene: ${names.join(", ")})` : " (no tiene contactos cargados)"}. Pedile el email de esa persona para invitarla.`,
      };
    }
  }
  return { ok: out };
};

export const runAgendaTool = async (
  uid: string,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> => {
  const issues = (e: z.ZodError) => ({ error: e.issues.map((i) => i.message).join("; ") });

  if (name === "add_activity") {
    const parsed = addSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const people = await resolvePeople(uid, p.people ?? []);
    if ("error" in people) return people;
    const me = await loadMe(uid);
    if (!me.email) return { error: "El usuario no tiene email en su perfil: que la cargue desde la app" };
    const activity = await createActivityAdmin(
      me,
      {
        title: p.title,
        date: p.date,
        time: p.time ?? null,
        location: p.location ?? null,
        notes: p.notes ?? null,
        estimatedAmount: p.estimatedAmount ?? null,
        currency: p.currency ?? "ARS",
      },
      people.ok.filter((x) => x.email !== me.email),
    );
    return {
      ok: true,
      id: activity.id,
      when: whenText(activity),
      invited: people.ok.map(participantName),
      note: "Ya quedó agendada. Si lleva un gasto, cuando pase se carga como cualquier gasto (propose_transaction).",
    };
  }

  if (name === "get_agenda") {
    const parsed = agendaSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const today = todayYMD();
    const from = parsed.data.from ?? today;
    const to = parsed.data.to ?? addDaysYMD(from, 7);
    const list = await listAgenda(uid, from, to);
    return {
      from,
      to,
      activities: list.map((a) => {
        const me = a.participants.find((x) => x.uid === uid);
        const others = a.participants
          .filter((x) => x.uid !== uid && x.status !== "rejected")
          .map((x) => `${participantName(x)}${x.status === "pending" ? " (invitado)" : ""}`);
        const expense = a.expenses?.[uid];
        return {
          id: a.id,
          day: dayLabel(a.date, today),
          date: a.date,
          time: a.time ?? "todo el día",
          title: a.title,
          ...(a.location ? { location: a.location } : {}),
          ...(others.length ? { with: others } : {}),
          ...(me?.status === "pending"
            ? { invitation: `invitación de ${a.ownerDisplayName || a.ownerEmail} sin responder` }
            : {}),
          ...(a.estimatedAmount ? { estimated: formatMoney(a.estimatedAmount, a.currency ?? "ARS") } : {}),
          ...(expense ? { expenseLoaded: formatMoney(expense.amount, expense.currency) } : {}),
        };
      }),
    };
  }

  if (name === "respond_activity") {
    const parsed = respondSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const me = await loadMe(uid);
    try {
      await respondToActivity({ uid, email: me.email || null }, parsed.data.activityId, parsed.data.going ? "accepted" : "rejected");
    } catch (err) {
      if (err instanceof ActivityError) return { error: err.message };
      throw err;
    }
    return { ok: true, going: parsed.data.going };
  }

  if (name === "update_activity") {
    const parsed = updateSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const snap = await adminDb().collection("activities").doc(p.activityId).get();
    if (!snap.exists) return { error: "Esa actividad ya no existe" };
    const a = { id: snap.id, ...snap.data() } as Activity;
    if (a.ownerUid !== uid) return { error: "La organiza otra persona: solo ella la puede cambiar" };
    try {
      const r = await updateActivityAdmin(
        uid,
        a.id,
        {
          title: p.title ?? a.title,
          date: p.date ?? a.date,
          time: p.allDay ? null : (p.time ?? a.time ?? null),
          location: p.location ?? a.location ?? null,
          notes: a.notes ?? null,
          estimatedAmount: a.estimatedAmount ?? null,
          currency: a.currency ?? null,
        },
        a.participants.filter((x) => x.status !== "owner"),
      );
      return { ok: true, notifiedInvitees: r.notifiedChange };
    } catch (err) {
      if (err instanceof ActivityError) return { error: err.message };
      throw err;
    }
  }

  if (name === "cancel_activity") {
    const parsed = cancelSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    try {
      const r = await cancelActivityAdmin(uid, parsed.data.activityId);
      return { ok: true, notifiedInvitees: r.notified };
    } catch (err) {
      if (err instanceof ActivityError) return { error: err.message };
      throw err;
    }
  }

  return { error: `Herramienta desconocida: ${name}` };
};
