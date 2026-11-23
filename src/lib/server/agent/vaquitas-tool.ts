import "server-only";

import { randomUUID } from "node:crypto";
import type { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../firebase-admin";
import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { tryGetAppRates } from "../fx";
import { isYMD, todayYMD } from "../time";
import { loadVaquitaMovements, loadVaquitasFor, type ExpenseInput, type MemberInput, type PaymentInput } from "../vaquitas";
import { CARD_CURRENCIES, CURRENCIES, type Currency } from "@/lib/domain/types";
import {
  carriedShares,
  computeShares,
  crossRate,
  defaultExpenseDate,
  firstName,
  linkScore,
  linkablePeople,
  normalizeVaquitaDates,
  summarizeVaquita,
  toVaquitaCurrency,
  unitOfMember,
  vaquitaDateText,
  vaquitaUnits,
  type Vaquita,
  type VaquitaExpense,
  type VaquitaMember,
  type VaquitaSplitMode,
} from "@/lib/domain/vaquitas";
import { formatMoney } from "@/lib/format";
import type { ServerAccountInfo } from "../queries-admin";
import type { AgentPerson } from "../people";
import { findUserByQuery } from "../connections";
import { formatPhone, parseContactQuery } from "@/lib/domain/phone";
import { profileName } from "@/lib/domain/people";
import type { Draft, VaquitaDraft } from "../whatsapp/types";

/**
 * Vaquitas por WhatsApp: ver cómo van, crear una, cargar gastos y registrar
 * pagos para saldar. Crear, cargar y pagar arman un borrador que el usuario
 * confirma con un botón (lo guarda handle-message con lib/server/vaquitas).
 */

export interface VaquitaToolContext {
  uid: string;
  accounts: ServerAccountInfo[];
  people: AgentPerson[];
  proposedDraft: Draft | null;
}

const VAQUITA_REF = {
  type: "string",
  description: "id (de get_vaquitas) o nombre de la vaquita. Si no lo dice y hay una sola abierta, omitilo.",
} as const;
const WHO = {
  type: "string",
  description: 'Nombre de un integrante de la vaquita, o "yo" para el usuario.',
} as const;

export const VAQUITA_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "get_vaquitas",
      description:
        "Las vaquitas del usuario (gastos en grupo: cenas, viajes entre familias). Sin vaquita: la lista con el total y cómo está su parte. Con vaquita: integrantes, familias, saldos, quién le paga a quién y los últimos gastos.",
      parameters: {
        type: "object",
        properties: { vaquita: VAQUITA_REF },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_vaquita_expense",
      description:
        'Arma un gasto de una vaquita para confirmar ("anotá en la vaquita del viaje: nafta 40 mil, pagué yo en efectivo", "en la cena pagó Lean 60 lucas"). Si no dice cómo se divide, se divide como el último gasto de esa vaquita (o entre todos). NO uses propose_transaction para gastos de una vaquita: este ya lo carga en sus cuentas. Si es un gasto que YA cargó como gasto común ("el de 29 mil de la visa era de la vaquita", "pasalo a la vaquita"), buscalo con list_recent_transactions y mandá fromTransactionId: lo pasa sin duplicarlo (misma cuenta, cuotas y fecha).',
      parameters: {
        type: "object",
        properties: {
          vaquita: VAQUITA_REF,
          description: { type: "string", description: 'Qué fue ("Nafta", "Cena", "Súper"). Si no lo dice, "Gasto".' },
          amount: { type: "number", description: "Monto (obligatorio, salvo con fromTransactionId)" },
          currency: { type: "string", enum: CURRENCIES, description: 'Moneda del gasto (por defecto, la de la vaquita). Si dice pesos, "lucas" o "mil" en una vaquita en otra moneda, ARS.' },
          date: { type: "string", description: "YYYY-MM-DD, solo si dice la fecha. Si no la dice, omitilo: va hoy o el día más cercano dentro de las fechas de la vaquita" },
          paidBy: { ...WHO, description: 'Quién pagó todo ("yo" por defecto)' },
          payers: {
            type: "array",
            description: 'Si pagaron varios: quién y cuánto (suman el total). En vez de paidBy.',
            items: {
              type: "object",
              properties: { who: WHO, amount: { type: "number" } },
              required: ["who", "amount"],
              additionalProperties: false,
            },
          },
          splitMode: {
            type: "string",
            enum: ["people", "families", "amounts"],
            description: "people: iguales por persona · families: iguales por familia · amounts: montos (con amounts)",
          },
          splitAmong: {
            type: "array",
            items: { type: "string" },
            description: 'Entre quiénes (nombres de integrantes, o de familias si splitMode=families). Por defecto, todos. "nosotros" = la familia del usuario.',
          },
          amounts: {
            type: "array",
            description: "splitMode=amounts: cuánto le toca a cada uno (suman el total)",
            items: {
              type: "object",
              properties: { who: WHO, amount: { type: "number" } },
              required: ["who", "amount"],
              additionalProperties: false,
            },
          },
          shareInFamily: {
            type: "boolean",
            description:
              'Si pagó alguien de una familia: que la parte de la familia vaya a los gastos de cada integrante (ej. "compartilo con Orne"). Default false (queda en los de quien pagó).',
          },
          accountId: { type: "string", description: "Si pagó el usuario: id de SU cuenta con la que pagó (de Cuentas del usuario)" },
          installments: { type: "number", description: "Cuotas, si pagó con tarjeta" },
          noAccount: { type: "boolean", description: 'true si no quiere anotarlo en sus cuentas ("no lo anotes en mis cuentas")' },
          expenseId: {
            type: "string",
            description: "Para CORREGIR un gasto que ya está en la vaquita: su id (de get_vaquitas, lastExpenses). Mandá solo lo que cambia; lo demás queda como estaba.",
          },
          fromTransactionId: {
            type: "string",
            description: "id (de list_recent_transactions) de un gasto suyo YA cargado que pasa a la vaquita. Pagó él, con esa cuenta: no mandes amount distinto, accountId ni payers.",
          },
          allowDuplicate: {
            type: "boolean",
            description: "true solo si el usuario confirmó que es OTRO gasto distinto del parecido que ya tiene cargado",
          },
          rate: { type: "number", description: "Cotización a mano: unidades de la moneda de la vaquita por 1 de currency (solo si la dijo)" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_vaquita_payment",
      description:
        'Arma un pago entre integrantes para saldar la vaquita ("Lean me pasó 80 mil de la vaquita", "le pagué a Pau lo del viaje"). Si no dice el monto, usa lo que le toca según quién le paga a quién.',
      parameters: {
        type: "object",
        properties: {
          vaquita: VAQUITA_REF,
          from: { ...WHO, description: 'Quién pagó ("yo" por defecto)' },
          to: { ...WHO, description: "A quién le pagó" },
          amount: { type: "number" },
          currency: { type: "string", enum: CURRENCIES, description: 'Por defecto, la de la vaquita. Si dice pesos, "lucas" o "mil" en una vaquita en otra moneda, ARS (al volver se suele saldar en pesos).' },
          date: { type: "string", description: "YYYY-MM-DD (por defecto hoy)" },
          accountId: { type: "string", description: "Si el usuario es quien pagó o cobró: id de SU cuenta (no tarjeta)" },
          noAccount: { type: "boolean", description: "true si no quiere anotarlo en sus cuentas" },
          rate: { type: "number", description: "Cotización a mano (solo si la dijo)" },
          note: { type: "string" },
        },
        required: ["to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_vaquita",
      description:
        'Arma una vaquita nueva para confirmar ("armá una vaquita Cena del viernes con Orne, Lean y Pau", "vaquita para el viaje a Brasil en reales: familia 1 yo y Orne, familia 2 Lean y Pau"). El usuario entra solo.',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          currency: { type: "string", enum: CURRENCIES, description: "Moneda del viaje/salida (ARS por defecto)" },
          startDate: { type: "string", description: 'YYYY-MM-DD. Un día ("la cena del sábado"): solo startDate. Varios días ("del 10 al 20 de enero"): startDate y endDate. Si no dice cuándo, omitilo.' },
          endDate: { type: "string", description: "YYYY-MM-DD, último día (solo si son varios días)" },
          people: {
            type: "array",
            items: { type: "string" },
            description: "Nombres de los demás (de Personas, o alguien sin la app: se agrega por nombre). Sin el usuario.",
          },
          families: {
            type: "array",
            description: 'Familias (opcional). members con nombres; "yo" para el usuario.',
            items: {
              type: "object",
              properties: { name: { type: "string" }, members: { type: "array", items: { type: "string" } } },
              required: ["name", "members"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "people"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_vaquita_expense",
      description:
        'Borra un gasto de una vaquita ("borrá el gasto del hielo de la vaquita", "ese de 29 mil estaba repetido, sacalo"). Se saca también de las cuentas de todos. Buscá el id con get_vaquitas (lastExpenses). Queda para confirmar con botón.',
      parameters: {
        type: "object",
        properties: {
          vaquita: VAQUITA_REF,
          expenseId: { type: "string", description: "id del gasto (de get_vaquitas, lastExpenses)" },
        },
        required: ["expenseId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_vaquita_members",
      description:
        'Suma gente a una vaquita que ya existe ("sumá a Juan a la vaquita", "agregá a Pau, su WhatsApp es 11 5555-1234"). Cada uno: alguien de Personas, alguien por su WhatsApp/email (si usa La Libreta le llega la solicitud; si no, queda invitado y se vincula cuando se suma), o solo un nombre (sin la app). Queda para confirmar con botón.',
      parameters: {
        type: "object",
        properties: {
          vaquita: VAQUITA_REF,
          people: { type: "array", items: { type: "string" }, description: "Nombres (de Personas, o alguien sin la app)" },
          contacts: {
            type: "array",
            description: "Gente por su WhatsApp o email (si no está en Personas)",
            items: {
              type: "object",
              properties: { contact: { type: "string" }, name: { type: "string", description: "Cómo se llama (obligatorio si no usa La Libreta)" } },
              required: ["contact"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_vaquita_member",
      description:
        'Vincula a alguien que está "sin app" en una vaquita con su cuenta de La Libreta (de Personas, que usa la app): "el Leandro de la vaquita es Leandro de mis contactos", "Lean ya se sumó a la app". Desde ahí ve la vaquita y su parte va a sus gastos. Queda para confirmar con botón.',
      parameters: {
        type: "object",
        properties: {
          vaquita: VAQUITA_REF,
          member: { type: "string", description: 'Nombre del integrante "sin app" de la vaquita' },
          person: { type: "string", description: "person (ref) o nombre de alguien de Personas que usa la app. Si no lo dice, el que se llame igual." },
          contact: {
            type: "string",
            description: "Su WhatsApp o su email, si no está en Personas: si usa La Libreta le llega la solicitud y se vincula cuando acepta; si no, se lo invita y se vincula cuando se suma.",
          },
        },
        required: ["member"],
        additionalProperties: false,
      },
    },
  },
];

export const VAQUITA_TOOL_NAMES = new Set(VAQUITA_TOOLS.map((t) => t.function.name));

// ---------- Schemas ----------

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));
const optYMD = optStr.refine((v) => !v || isYMD(v), "las fechas deben ser YYYY-MM-DD");
const whoAmount = z.object({ who: z.string().min(1), amount: z.number().positive() });

const getSchema = z.object({ vaquita: optStr });
const addSchema = z.object({
  vaquita: optStr,
  people: z.array(z.string().min(1)).max(30).optional(),
  contacts: z.array(z.object({ contact: z.string().min(1), name: optStr })).max(30).optional(),
});
const linkSchema = z.object({ vaquita: optStr, member: z.string().min(1), person: optStr, contact: optStr });
const expenseSchema = z.object({
  vaquita: optStr,
  description: z.string().trim().max(80).optional(),
  amount: z.number().positive().max(10_000_000_000).optional(),
  currency: z.enum(CURRENCIES).optional(),
  date: optYMD,
  paidBy: optStr,
  payers: z.array(whoAmount).max(30).optional(),
  splitMode: z.enum(["people", "families", "amounts"]).optional(),
  splitAmong: z.array(z.string().min(1)).max(50).optional(),
  amounts: z.array(whoAmount).max(50).optional(),
  shareInFamily: z.boolean().optional(),
  accountId: optStr,
  installments: z.number().int().min(1).max(60).optional(),
  noAccount: z.boolean().optional(),
  rate: z.number().positive().optional(),
  fromTransactionId: optStr,
  allowDuplicate: z.boolean().optional(),
  expenseId: optStr,
});
const deleteSchema = z.object({ vaquita: optStr, expenseId: z.string().min(1) });
const paymentSchema = z.object({
  vaquita: optStr,
  from: optStr,
  to: z.string().trim().min(1),
  amount: z.number().positive().max(10_000_000_000).optional(),
  currency: z.enum(CURRENCIES).optional(),
  date: optYMD,
  accountId: optStr,
  noAccount: z.boolean().optional(),
  rate: z.number().positive().optional(),
  note: optStr,
});
const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  currency: z.enum(CURRENCIES).optional(),
  startDate: optYMD,
  endDate: optYMD,
  people: z.array(z.string().trim().min(1)).max(40),
  families: z.array(z.object({ name: z.string().trim().min(1).max(40), members: z.array(z.string().min(1)).max(40) })).max(20).optional(),
});

// ---------- Helpers ----------

type Result = Record<string, unknown>;
const round2 = (n: number) => Math.round(n * 100) / 100;
const BUILT = "Borrador listo. El sistema le manda el resumen al usuario con los botones. No agregues nada más.";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const ME_WORDS = new Set(["yo", "me", "mi", "vos", "el usuario", "usuario"]);
const US_WORDS = new Set(["nosotros", "mi familia", "nuestra familia", "nuestra parte", "los mios"]);

/** El que coincide sin dudas: exacto, después nombre de pila, después contiene. */
const pickByName = <T>(pool: T[], q: string, nameOf: (x: T) => string): { hit: T } | { many: T[] } | { none: true } => {
  const n = norm(q);
  if (!n) return { none: true };
  const squash = (t: string) => t.replace(/ /g, "");
  const tries = [
    (x: T) => norm(nameOf(x)) === n,
    // "junta dita de hoy" → «Juntadita de hoy»
    (x: T) => squash(norm(nameOf(x))) === squash(n),
    (x: T) => norm(nameOf(x)).split(" ")[0] === n,
    (x: T) => norm(nameOf(x)).startsWith(n),
    (x: T) => norm(nameOf(x)).includes(n) || (n.length >= 4 && n.includes(norm(nameOf(x)))),
  ];
  for (const t of tries) {
    const hits = pool.filter(t);
    if (hits.length === 1) return { hit: hits[0] };
    if (hits.length > 1) return { many: hits };
  }
  return { none: true };
};

const memberLabel = (m: VaquitaMember, uid: string) => (m.uid === uid ? "vos" : firstName(m.name));

const findMember = (
  v: Vaquita,
  who: string | undefined,
  uid: string,
  people: AgentPerson[] = [],
): { member: VaquitaMember } | { error: string } => {
  const me = v.members.find((m) => m.uid === uid);
  if (!who || ME_WORDS.has(norm(who)) || US_WORDS.has(norm(who))) {
    return me ? { member: me } : { error: "El usuario no está en esa vaquita." };
  }
  // El borrador que ve el modelo trae ids de integrantes (m_…).
  const byId = v.members.find((m) => m.id === who.trim());
  if (byId) return { member: byId };
  const r = pickByName(v.members, who, (m) => m.name);
  if ("hit" in r) return { member: r.hit };
  // Los que usan la app: también por cómo los nombra en Personas ("mi señora", "Orne").
  if ("none" in r) {
    const n = norm(who);
    const byNick = v.members.filter((m) => {
      if (!m.uid) return false;
      const p = people.find((x) => x.ref === `u:${m.uid}`);
      return !!p && [p.name, ...p.nicknames].some((x) => norm(x) === n || norm(x).split(" ")[0] === n);
    });
    if (byNick.length === 1) return { member: byNick[0] };
  }
  if ("many" in r) return { error: `"${who}" coincide con ${r.many.map((m) => m.name).join(", ")}. Preguntale cuál.` };
  return { error: `"${who}" no está en «${v.name}». Están: ${v.members.map((m) => m.name).join(", ")}.` };
};

/** Una parte (familia o persona suelta) por nombre de familia o de alguien de ella. */
const findUnit = (v: Vaquita, who: string, uid: string, people: AgentPerson[] = []): { unitId: string } | { error: string } => {
  const units = vaquitaUnits(v);
  const unitOf = unitOfMember(units);
  const families = units.filter((u) => u.isFamily);
  if (!US_WORDS.has(norm(who)) && !ME_WORDS.has(norm(who))) {
    const f = pickByName(families, who, (u) => u.name);
    if ("hit" in f) return { unitId: f.hit.id };
  }
  const m = findMember(v, who, uid, people);
  if ("error" in m) return m;
  return { unitId: unitOf.get(m.member.id)! };
};

const resolveVaquita = (list: Vaquita[], ref: string | undefined): { v: Vaquita } | { error: string } => {
  const open = list.filter((v) => v.status !== "closed");
  if (!ref) {
    if (open.length === 1) return { v: open[0] };
    if (open.length === 0) {
      return { error: "No tiene vaquitas abiertas. Se arma una con propose_vaquita (o desde la app, en Vaquitas)." };
    }
    return { error: `Tiene varias vaquitas abiertas: ${open.map((v) => `«${v.name}» (id ${v.id})`).join(", ")}. Preguntale en cuál.` };
  }
  const byId = list.find((v) => v.id === ref);
  if (byId) return { v: byId };
  const inOpen = pickByName(open, ref, (v) => v.name);
  if ("hit" in inOpen) return { v: inOpen.hit };
  const inAll = pickByName(list, ref, (v) => v.name);
  if ("hit" in inAll) return { v: inAll.hit };
  const many = "many" in inOpen ? inOpen.many : "many" in inAll ? inAll.many : null;
  if (many) return { error: `"${ref}" coincide con ${many.map((v) => `«${v.name}» (id ${v.id})`).join(", ")}. Preguntale cuál.` };
  return {
    error: `No encontré la vaquita "${ref}".${list.length ? ` Tiene: ${list.map((v) => `«${v.name}»${v.status === "closed" ? " (cerrada)" : ""}`).join(", ")}.` : ""}`,
  };
};

/** Unidades de la moneda de la vaquita por 1 de `from` (a mano o la oficial de hoy). */
const rateFor = async (from: Currency, to: Currency, manual?: number): Promise<number | null> => {
  if (from === to) return 1;
  if (manual) return manual;
  return crossRate(from, to, (await tryGetAppRates())?.rates);
};

/** Cuenta del usuario para lo que pagó: la que dijo, la principal o una de efectivo. */
const pickMyAccount = (
  accounts: ServerAccountInfo[],
  currency: Currency,
  accountId: string | undefined,
  allowCards: boolean,
): { account: ServerAccountInfo } | { error: string } => {
  const active = accounts.filter((a) => a.active);
  if (accountId) {
    const a = active.find((x) => x.id === accountId);
    if (!a) return { error: "Esa cuenta no existe." };
    if (a.type === "credit") {
      if (!allowCards) return { error: "Para un pago va una cuenta, no una tarjeta." };
      if (!CARD_CURRENCIES.includes(currency)) return { error: "Las tarjetas cobran en pesos o dólares: si pagó en otra moneda, fue en efectivo u otra cuenta." };
    }
    if (a.type === "reserve" && !a.currencies.includes(currency)) return { error: `"${a.name}" no maneja esa moneda.` };
    return { account: a };
  }
  const cash = active.filter((a) => a.type !== "credit" && a.type !== "reserve");
  const pick =
    cash.find((a) => a.isMain && a.currencies.includes(currency)) ??
    cash.find((a) => a.currencies.includes(currency)) ??
    // Moneda que no tiene en ninguna cuenta (ej. reales en un viaje): efectivo.
    cash.find((a) => a.type === "cash");
  if (!pick) return { error: "¿Con qué cuenta pagó? Preguntale (o noAccount si no lo quiere anotar)." };
  return { account: pick };
};

const ymdAR = (d: Date) => todayYMD(d);

/** Un gasto suyo ya cargado que se puede pasar a la vaquita (los mismos chequeos que el server, con mensajes para el modelo). */
const loadMovable = async (
  uid: string,
  txId: string,
): Promise<
  | { id: string; amount: number; currency: Currency; date: string; description: string; accountName: string; installments: number }
  | { error: string }
> => {
  if (txId.includes("/")) return { error: "Ese id no es de un movimiento." };
  const snap = await adminDb().doc(`users/${uid}/transactions/${txId}`).get();
  const t = snap.data();
  if (!t) return { error: "No encontré ese movimiento: buscalo de nuevo con list_recent_transactions." };
  if (t.kind !== "expense") return { error: "Solo se pueden pasar gastos." };
  if (t.vaquitaId) return { error: "Ese gasto ya es de una vaquita." };
  if (t.splitId || t.p2pTransferId) return { error: "Ese gasto es parte de un reparto con alguien: no se puede pasar." };
  if (t.recurringId) return { error: "Es un gasto fijo: no se puede pasar a una vaquita." };
  const acc = (await adminDb().doc(`users/${uid}/accounts/${t.accountId}`).get()).data();
  return {
    id: snap.id,
    amount: round2(Number(t.totalAmount) || 0),
    currency: ((t.currency as Currency | undefined) ?? "ARS") as Currency,
    date: ymdAR((t.purchaseDate as Timestamp).toDate()),
    description: String(t.description ?? ""),
    accountName: String(acc?.name ?? "tu cuenta"),
    installments: Math.max(1, Number(t.installments) || 1),
  };
};

/** Gasto común reciente con el mismo monto (±7 días): probablemente es este mismo. */
const findLookalike = async (uid: string, amount: number, currency: Currency, date: string) => {
  const snap = await adminDb().collection(`users/${uid}/transactions`).orderBy("createdAt", "desc").limit(40).get();
  const target = new Date(`${date}T12:00:00Z`).getTime();
  for (const d of snap.docs) {
    const t = d.data();
    if (t.kind !== "expense" || t.vaquitaId || t.splitId || t.p2pTransferId || t.recurringId) continue;
    if (((t.currency as Currency | undefined) ?? "ARS") !== currency) continue;
    if (Math.abs(Number(t.totalAmount) - amount) >= 0.01) continue;
    const when = (t.purchaseDate as Timestamp).toDate();
    if (Math.abs(when.getTime() - target) > 7 * 86_400_000) continue;
    const acc = (await adminDb().doc(`users/${uid}/accounts/${t.accountId}`).get()).data();
    return {
      id: d.id,
      description: String(t.description ?? ""),
      amount: Number(t.totalAmount),
      currency,
      accountName: String(acc?.name ?? "una cuenta"),
      date: ymdAR(when),
    };
  }
  return null;
};

const draftBase = (op: VaquitaDraft["op"], vaquitaName: string, title: string, lines: string[]) => ({
  type: "vaquita" as const,
  id: randomUUID().slice(0, 8),
  op,
  vaquitaName,
  title,
  lines,
  createdAt: Date.now(),
});

// ---------- Ejecutor ----------

export const runVaquitaTool = async (ctx: VaquitaToolContext, name: string, args: unknown): Promise<Result> => {
  const issues = (e: z.ZodError) => ({ error: e.issues.map((i) => i.message).join("; ") });
  const uid = ctx.uid;

  if (name === "propose_vaquita") {
    const parsed = createSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const currency = p.currency ?? "ARS";
    // Cada nombre: alguien de Personas o alguien sin la app.
    const members: Array<MemberInput & { label: string; key: string }> = [];
    for (const raw of p.people) {
      if (ME_WORDS.has(norm(raw))) continue;
      // Primero por apodo exacto ("mi señora", "el Colo"), después por nombre.
      const byNick = ctx.people.filter((x) => x.nicknames.some((nn) => norm(nn) === norm(raw)));
      const r = byNick.length === 1 ? { hit: byNick[0] } : pickByName(ctx.people, raw, (x) => x.name);
      if ("many" in r) return { error: `"${raw}" coincide con ${r.many.map((x) => x.name).join(", ")}. Preguntale cuál.` };
      const key = norm(raw);
      if ("hit" in r) {
        if (members.some((m) => m.ref === r.hit.ref)) continue;
        members.push({ ref: r.hit.ref, label: `${r.hit.name}${r.hit.isApp ? "" : " (sin app)"}`, key });
      } else {
        members.push({ name: raw.trim(), label: `${raw.trim()} (sin app, lo agrego)`, key });
      }
    }
    if (members.length === 0) return { error: "Faltan los demás integrantes." };
    const families = (p.families ?? []).map((f, i) => ({ id: `f_wa${i}`, name: f.name, members: f.members }));
    let myFamilyId: string | null = null;
    for (const f of families) {
      for (const who of f.members) {
        if (ME_WORDS.has(norm(who))) {
          myFamilyId = f.id;
          continue;
        }
        const m = members.find((x) => x.key === norm(who)) ?? pickByName(members, who, (x) => x.label);
        const target = m && "key" in m ? m : m && "hit" in m ? m.hit : null;
        if (!target) return { error: `"${who}" está en ${f.name} pero no entre los integrantes. Sumalo a people.` };
        target.familyId = f.id;
      }
    }
    const dates = normalizeVaquitaDates(p.startDate, p.endDate);
    if ("error" in dates) return { error: dates.error };
    const when = vaquitaDateText(dates);
    const lines = [...(when ? [`Cuándo: ${when}`] : []), `Moneda: ${currency}`, "", "*Integrantes*", "• Vos", ...members.map((m) => `• ${m.label}`)];
    if (families.length) {
      lines.push("", "*Familias*");
      for (const f of families) {
        const names = [
          ...(myFamilyId === f.id ? ["vos"] : []),
          ...members.filter((m) => m.familyId === f.id).map((m) => m.label.replace(/ \(.*\)$/, "")),
        ];
        lines.push(`• ${f.name}: ${names.join(", ")}`);
      }
    }
    lines.push("", "_Los que usan la app la ven y la editan._");
    ctx.proposedDraft = {
      ...draftBase("create", p.name, `🐮 *Vaquita nueva: ${p.name}*`, lines),
      create: {
        name: p.name,
        currency,
        ...dates,
        members: members.map(({ ref, name, familyId }) => ({ ...(ref ? { ref } : { name }), familyId: familyId ?? null })),
        families: families.map(({ id, name }) => ({ id, name })),
        myFamilyId,
      },
    };
    return { ok: true, message: BUILT };
  }

  const list = await loadVaquitasFor(uid);

  if (name === "get_vaquitas") {
    const parsed = getSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    if (!parsed.data.vaquita) {
      if (list.length === 0) return { vaquitas: [], note: "No tiene vaquitas. Se arman con propose_vaquita o en la app (Vaquitas)." };
      const sorted = [...list].sort((a, b) => Number(a.status === "closed") - Number(b.status === "closed"));
      return {
        vaquitas: sorted.slice(0, 15).map((v) => {
          const me = v.members.find((m) => m.uid === uid);
          const unit = me ? unitOfMember(vaquitaUnits(v)).get(me.id) : undefined;
          const net = unit ? (v.summary?.netByUnit?.[unit] ?? 0) : 0;
          return {
            id: v.id,
            name: v.name,
            status: v.status === "closed" ? "cerrada" : "abierta",
            ...(vaquitaDateText(v) ? { when: vaquitaDateText(v) } : {}),
            members: v.members.map((m) => (m.uid === uid ? "vos" : m.name)),
            total: formatMoney(v.summary?.total ?? 0, v.currency),
            mine: Math.abs(net) < 0.01 ? "a mano" : net > 0 ? `recibe ${formatMoney(net, v.currency)}` : `debe ${formatMoney(-net, v.currency)}`,
          };
        }),
        appUrl: "/vaquitas",
      };
    }
    const r = resolveVaquita(list, parsed.data.vaquita);
    if ("error" in r) return r;
    const v = r.v;
    const { expenses, payments } = await loadVaquitaMovements(v.id);
    const s = summarizeVaquita(v, expenses, payments);
    const me = v.members.find((m) => m.uid === uid);
    const unitName = (id: string) => {
      const u = s.units.find((x) => x.id === id);
      if (!u) return "?";
      if (u.isFamily) return u.name;
      const m = v.members.find((x) => x.id === u.memberIds[0]);
      return m ? memberLabel(m, uid) : u.name;
    };
    const myUnit = me ? unitOfMember(s.units).get(me.id) : undefined;
    const name_ = (id: string) => {
      const m = v.members.find((x) => x.id === id);
      return m ? memberLabel(m, uid) : "?";
    };
    const mine = round2(expenses.reduce((acc, e) => acc + toVaquitaCurrency(carriedShares(v, e).get(uid) ?? 0, e.rate), 0));
    const fx = v.currency !== "ARS" ? (await tryGetAppRates())?.rates?.[v.currency] : null;
    return {
      id: v.id,
      name: v.name,
      status: v.status === "closed" ? "cerrada" : "abierta",
      ...(vaquitaDateText(v) ? { when: vaquitaDateText(v) } : {}),
      currency: v.currency,
      total: formatMoney(s.total, v.currency),
      ...(fx ? { totalInPesosToday: formatMoney(round2(s.total * fx), "ARS") } : {}),
      toUserBooks: formatMoney(mine, v.currency),
      members: v.members.map((m) => `${memberLabel(m, uid)}${m.uid ? "" : " (sin app)"}${m.familyId ? ` · ${v.families.find((f) => f.id === m.familyId)?.name ?? ""}` : ""}`),
      balances: s.units.map((u) => ({
        part: unitName(u.id) + (u.id === myUnit ? " (la del usuario)" : ""),
        paid: formatMoney(u.paid, v.currency),
        share: formatMoney(u.share, v.currency),
        net: Math.abs(u.net) < 0.01 ? "a mano" : u.net > 0 ? `recibe ${formatMoney(u.net, v.currency)}` : `debe ${formatMoney(-u.net, v.currency)}`,
      })),
      whoPaysWhom: s.settlements.length
        ? s.settlements.map((x) => `${unitName(x.fromUnit)} → ${unitName(x.toUnit)}: ${formatMoney(x.amount, v.currency)}`)
        : ["están a mano"],
      lastExpenses: expenses.slice(0, 12).map((e) => ({
        id: e.id,
        date: e.date,
        description: e.description,
        amount: formatMoney(e.amount, e.currency),
        paidBy: Object.keys(e.paidBy).map(name_).join(" y "),
      })),
      expenses: expenses.length,
      payments: payments.slice(0, 8).map((p) => `${p.date}: ${name_(p.from)} → ${name_(p.to)} ${formatMoney(p.amount, p.currency)}`),
      appUrl: `/vaquitas/${v.id}`,
    };
  }

  if (name === "propose_vaquita_expense") {
    const parsed = expenseSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const r = resolveVaquita(list, p.vaquita);
    if ("error" in r) return r;
    const v = r.v;
    if (v.status === "closed") return { error: `«${v.name}» está cerrada. Se abre de nuevo desde la app (Ajustes de la vaquita).` };
    const me = v.members.find((m) => m.uid === uid) ?? null;

    // Corregir uno que ya está: lo que no viene queda como estaba.
    let prev: VaquitaExpense | null = null;
    if (p.expenseId) {
      if (p.fromTransactionId) return { error: "Para corregir un gasto de la vaquita no va fromTransactionId." };
      const { expenses } = await loadVaquitaMovements(v.id);
      prev = expenses.find((e) => e.id === p.expenseId) ?? null;
      if (!prev) return { error: `No encontré ese gasto en «${v.name}»: buscalo con get_vaquitas (lastExpenses).` };
    }

    // Pasar un gasto ya cargado: monto, moneda, fecha y cuenta salen de ese movimiento.
    const moved = p.fromTransactionId ? await loadMovable(uid, p.fromTransactionId) : null;
    if (moved && "error" in moved) return moved;
    if (moved && !me) return { error: "El usuario no está en esa vaquita." };
    if (!moved && !prev && !p.amount) return { error: "Falta el monto." };
    const amount = moved ? moved.amount : p.amount ? round2(p.amount) : prev!.amount;
    const currency = moved ? moved.currency : (p.currency ?? prev?.currency ?? v.currency);
    const description = (p.description || moved?.description || prev?.description || "Gasto").slice(0, 80);
    // Sin fecha: hoy, o el día más cercano dentro de las fechas de la vaquita. "Hoy" fuera de
    // las fechas de la vaquita suele ser el default del modelo: va al día más cercano.
    const today = todayYMD();
    const inRange = (d: string) => (!v.startDate || d >= v.startDate) && (!(v.endDate ?? v.startDate) || d <= (v.endDate ?? v.startDate)!);
    const date = moved
      ? moved.date
      : prev && !p.date
        ? prev.date
        : p.date && (prev || !(p.date === today && !inRange(today)))
        ? p.date
        : defaultExpenseDate(v, today);

    // Quién pagó.
    const paidBy: Record<string, number> = {};
    if (moved && me) {
      paidBy[me.id] = amount;
    } else if (p.payers?.length) {
      for (const x of p.payers) {
        const m = findMember(v, x.who, uid, ctx.people);
        if ("error" in m) return m;
        paidBy[m.member.id] = round2((paidBy[m.member.id] ?? 0) + x.amount);
      }
      const sum = round2(Object.values(paidBy).reduce((s, a) => s + a, 0));
      if (Math.abs(sum - amount) >= 0.01) return { error: `Lo que pagaron suma ${sum} y el gasto es ${amount}. Preguntale.` };
    } else if (prev && !p.paidBy) {
      // Los mismos que pagaron; si cambió el monto y pagó uno solo, ese paga el nuevo total.
      const ids = Object.keys(prev.paidBy);
      if (ids.length > 1 && Math.abs(amount - prev.amount) >= 0.01) {
        return { error: "Cambió el monto y pagaron varios: preguntale cuánto puso cada uno (payers)." };
      }
      if (ids.length === 1) paidBy[ids[0]] = amount;
      else Object.assign(paidBy, prev.paidBy);
    } else {
      const m = findMember(v, p.paidBy, uid, ctx.people);
      if ("error" in m) return m;
      paidBy[m.member.id] = amount;
    }

    // Entre quiénes: lo pedido, o como el último gasto, o entre todos.
    const units = vaquitaUnits(v);
    let mode: VaquitaSplitMode;
    let among: string[];
    let amounts: Record<string, number> | undefined;
    if (p.amounts?.length || p.splitMode === "amounts") {
      if (!p.amounts?.length) return { error: "Con splitMode=amounts van los montos de cada uno (amounts)." };
      mode = "amounts";
      amounts = {};
      for (const x of p.amounts) {
        const m = findMember(v, x.who, uid, ctx.people);
        if ("error" in m) return m;
        amounts[m.member.id] = round2((amounts[m.member.id] ?? 0) + x.amount);
      }
      among = Object.keys(amounts);
    } else if (p.splitAmong?.length || p.splitMode) {
      mode = p.splitMode ?? (units.some((u) => u.isFamily) ? "families" : "people");
      if (mode === "families") {
        among = [];
        for (const who of p.splitAmong ?? units.map((u) => u.id)) {
          const u = units.some((x) => x.id === who) ? { unitId: who } : findUnit(v, who, uid, ctx.people);
          if ("error" in u) return u;
          if (!among.includes(u.unitId)) among.push(u.unitId);
        }
      } else {
        among = [];
        for (const who of p.splitAmong ?? v.members.map((m) => m.id)) {
          // "nosotros" / una familia: todos los de esa parte.
          if (US_WORDS.has(norm(who)) || "hit" in pickByName(units.filter((u) => u.isFamily), who, (u) => u.name)) {
            const u = findUnit(v, who, uid, ctx.people);
            if ("error" in u) return u;
            for (const id of units.find((x) => x.id === u.unitId)?.memberIds ?? []) if (!among.includes(id)) among.push(id);
            continue;
          }
          const m = v.members.some((x) => x.id === who) ? { member: v.members.find((x) => x.id === who)! } : findMember(v, who, uid, ctx.people);
          if ("error" in m) return m;
          if (!among.includes(m.member.id)) among.push(m.member.id);
        }
      }
    } else if (prev) {
      // El mismo reparto (con montos fijos, solo si no cambió el total).
      if (prev.splitMode === "amounts" && Math.abs(amount - prev.amount) >= 0.01) {
        return { error: "Cambió el monto y estaba dividido por montos: preguntale cuánto le toca a cada uno (amounts)." };
      }
      mode = prev.splitMode;
      among = prev.splitAmong;
      if (prev.splitMode === "amounts") amounts = { ...prev.shares };
    } else {
      const { expenses } = await loadVaquitaMovements(v.id);
      const last = expenses.find((e) => e.splitMode !== "amounts");
      const valid = new Set([...v.members.map((m) => m.id), ...units.map((u) => u.id)]);
      if (last && last.splitAmong.every((id) => valid.has(id))) {
        mode = last.splitMode;
        among = last.splitAmong;
      } else if (units.some((u) => u.isFamily)) {
        mode = "families";
        among = units.map((u) => u.id);
      } else {
        mode = "people";
        among = v.members.map((m) => m.id);
      }
    }
    const shares = computeShares(v, { amount, splitMode: mode, splitAmong: among, amounts });
    if (shares.error) return { error: shares.error };

    // ¿Ya está este mismo gasto en la vaquita? (mismo monto, mismos que pagaron, ±2 días)
    if (!p.allowDuplicate && !moved && !prev) {
      const { expenses } = await loadVaquitaMovements(v.id);
      const near = (d: string) => Math.abs(new Date(`${d}T12:00:00Z`).getTime() - new Date(`${date}T12:00:00Z`).getTime()) <= 2 * 86_400_000;
      const samePayers = (e: { paidBy: Record<string, number> }) =>
        Object.keys(e.paidBy).sort().join() === Object.keys(paidBy).sort().join();
      const twin = expenses.find((e) => e.currency === currency && Math.abs(e.amount - amount) < 0.01 && samePayers(e) && near(e.date));
      if (twin) {
        return {
          error: `En «${v.name}» ya está «${twin.description}» ${formatMoney(twin.amount, twin.currency)} del ${twin.date.split("-").reverse().slice(0, 2).join("/")} pagado por los mismos. Preguntale si es otro gasto: si es, repetí con allowDuplicate: true.`,
        };
      }
    }

    const rate =
      prev && !p.rate && currency === prev.currency ? prev.rate : await rateFor(currency, v.currency, p.rate);
    if (!rate) return { error: `No conseguí la cotización de ${currency} a ${v.currency}. Preguntale a cuánto.` };

    // Con qué pagó el usuario (si pagó).
    const iPaid = !!me && (paidBy[me.id] ?? 0) > 0;
    let myLeg: ExpenseInput["myLeg"] = null;
    let accountText = "";
    const prevLeg = prev ? prev.legs?.[uid] : undefined;
    if (prev && iPaid && !p.accountId && !p.noAccount && !p.installments) {
      // Corrigiendo: la cuenta queda como estaba.
      myLeg = undefined;
      const acc = prevLeg ? ctx.accounts.find((a) => a.id === prevLeg.accountId) : undefined;
      accountText = acc
        ? `${acc.name}${prevLeg!.installments > 1 ? ` en ${prevLeg!.installments} cuotas` : ""}`
        : "sin cuenta (elegila en la app o decime con qué pagaste)";
    } else if (moved) {
      accountText = `${moved.accountName}${moved.installments > 1 ? ` en ${moved.installments} cuotas` : ""} · es tu gasto del ${moved.date.split("-").reverse().slice(0, 2).join("/")}: pasa a la vaquita, no se duplica`;
    } else if (iPaid && !p.noAccount) {
      const a = pickMyAccount(ctx.accounts, currency, p.accountId ?? (prev ? prevLeg?.accountId : undefined), true);
      if ("error" in a) return a;
      const installments = a.account.type === "credit" ? (p.installments ?? prevLeg?.installments ?? 1) : 1;
      myLeg = { accountId: a.account.id, installments };
      accountText = `${a.account.name}${installments > 1 ? ` en ${installments} cuotas` : ""}`;
      // ¿Ya lo tenía cargado como gasto común? (así se duplicó el cargo en la tarjeta).
      if (!p.allowDuplicate && !prev) {
        const dup = await findLookalike(uid, paidBy[me!.id], currency, date);
        if (dup) {
          return {
            error: `Ya tiene cargado un gasto parecido: «${dup.description || "sin descripción"}» ${formatMoney(dup.amount, dup.currency)} con ${dup.accountName} del ${dup.date.split("-").reverse().slice(0, 2).join("/")} (id ${dup.id}). Preguntale si es ese: si es, repetí con fromTransactionId: "${dup.id}" (lo pasa sin duplicar); si es otro gasto, repetí con allowDuplicate: true.`,
          };
        }
      }
    } else if (iPaid) {
      accountText = "no lo anoto en tus cuentas";
    }

    const shareInFamily = p.shareInFamily ?? prev?.shareInFamily ?? false;
    const myPart = carriedShares(v, { paidBy, shares: shares.shares, shareInFamily }).get(uid) ?? 0;
    const label = (id: string) => {
      const m = v.members.find((x) => x.id === id);
      return m ? (m.uid === uid ? "vos" : firstName(m.name)) : "?";
    };
    const unitLabel = (id: string) => {
      const u = units.find((x) => x.id === id);
      return u ? (u.isFamily ? u.name : label(u.memberIds[0])) : "?";
    };
    const payersText = Object.entries(paidBy)
      .map(([id, a]) => (Object.keys(paidBy).length > 1 ? `${label(id)} (${formatMoney(a, currency)})` : label(id)))
      .join(" y ");
    const splitText =
      mode === "amounts"
        ? Object.entries(shares.shares).map(([id, a]) => `${label(id)} ${formatMoney(a, currency)}`).join(", ")
        : mode === "families"
          ? `por familia: ${among.map(unitLabel).join(", ")} (${formatMoney(round2(amount / among.length), currency)} cada una)`
          : among.length === v.members.length
            ? `entre todos (${formatMoney(round2(amount / among.length), currency)} cada uno)`
            : `entre ${among.map(label).join(", ")} (${formatMoney(round2(amount / among.length), currency)} cada uno)`;
    const lines = [
      `*${description}* · ${formatMoney(amount, currency)}${currency !== v.currency ? ` (= ${formatMoney(toVaquitaCurrency(amount, rate), v.currency)})` : ""}`,
      `Pagó: ${payersText}${accountText ? ` · ${accountText}` : ""}`,
      `Se divide ${splitText}`,
      ...(shareInFamily ? ["Compartido en la familia: cada uno lo ve en sus gastos"] : []),
      `Fecha: ${date.split("-").reverse().join("/")}`,
      "",
      `Va a tus gastos: *${formatMoney(myPart, currency)}*`,
    ];
    ctx.proposedDraft = {
      ...draftBase("expense", v.name, prev ? `✏️ *Corregir gasto en «${v.name}»*` : `🐮 *Gasto en «${v.name}»*`, lines),
      expense: {
        vaquitaId: v.id,
        ...(prev ? { expenseId: prev.id } : {}),
        description,
        date,
        amount,
        currency,
        rate: currency === v.currency ? null : rate,
        paidBy,
        splitMode: mode,
        splitAmong: among,
        ...(amounts ? { amounts } : {}),
        shareInFamily,
        ...(moved ? { fromTransactionId: moved.id } : myLeg !== undefined ? { myLeg } : {}),
      },
    };
    return { ok: true, message: BUILT };
  }

  if (name === "propose_vaquita_payment") {
    const parsed = paymentSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const r = resolveVaquita(list, p.vaquita);
    if ("error" in r) return r;
    const v = r.v;
    const from = findMember(v, p.from, uid, ctx.people);
    if ("error" in from) return from;
    const to = findMember(v, p.to, uid, ctx.people);
    if ("error" in to) return to;
    if (from.member.id === to.member.id) return { error: "Quién pagó y a quién son la misma persona. Preguntale." };
    const currency = p.currency ?? v.currency;
    const rate = await rateFor(currency, v.currency, p.rate);
    if (!rate) return { error: `No conseguí la cotización de ${currency} a ${v.currency}. Preguntale a cuánto.` };

    let amount = p.amount ? round2(p.amount) : null;
    if (!amount) {
      const { expenses, payments } = await loadVaquitaMovements(v.id);
      const s = summarizeVaquita(v, expenses, payments);
      const unitOf = unitOfMember(s.units);
      const st = s.settlements.find(
        (x) => x.fromUnit === unitOf.get(from.member.id) && x.toUnit === unitOf.get(to.member.id),
      );
      if (!st) return { error: "No sale de quién le paga a quién cuánto es. Preguntale el monto." };
      amount = round2(st.amount / rate);
    }

    const iAmParty = from.member.uid === uid || to.member.uid === uid;
    let myAccountId: PaymentInput["myAccountId"];
    let accountText = "";
    if (iAmParty) {
      if (p.noAccount) {
        myAccountId = null;
        accountText = "no lo anoto en tus cuentas";
      } else {
        const a = pickMyAccount(ctx.accounts, currency, p.accountId, false);
        if ("error" in a) return a;
        myAccountId = a.account.id;
        accountText = `${from.member.uid === uid ? "Sale de" : "Entra en"}: ${a.account.name}`;
      }
    }
    const date = p.date ?? todayYMD();
    const lines = [
      `*${memberLabel(from.member, uid)}* le paga a *${memberLabel(to.member, uid)}* ${formatMoney(amount, currency)}${currency !== v.currency ? ` (= ${formatMoney(toVaquitaCurrency(amount, rate), v.currency)})` : ""}`,
      ...(accountText ? [accountText] : []),
      `Fecha: ${date.split("-").reverse().join("/")}`,
      "",
      "_No es gasto ni ingreso: salda la vaquita._",
    ];
    ctx.proposedDraft = {
      ...draftBase("payment", v.name, `🐮 *Pago en «${v.name}»*`, lines),
      payment: {
        vaquitaId: v.id,
        from: from.member.id,
        to: to.member.id,
        amount,
        currency,
        rate: currency === v.currency ? null : rate,
        date,
        note: p.note ?? "",
        ...(myAccountId !== undefined ? { myAccountId } : {}),
      },
    };
    return { ok: true, message: BUILT };
  }

  if (name === "delete_vaquita_expense") {
    const parsed = deleteSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const r = resolveVaquita(list, p.vaquita);
    if ("error" in r) return r;
    const v = r.v;
    const { expenses } = await loadVaquitaMovements(v.id);
    const e = expenses.find((x) => x.id === p.expenseId);
    if (!e) return { error: `No encontré ese gasto en «${v.name}»: buscalo con get_vaquitas (lastExpenses).` };
    const who = Object.keys(e.paidBy)
      .map((id) => {
        const m = v.members.find((x) => x.id === id);
        return m ? memberLabel(m, uid) : "?";
      })
      .join(" y ");
    ctx.proposedDraft = {
      ...draftBase("delete", v.name, `🗑️ *Borrar gasto de «${v.name}»*`, [
        `*${e.description}* · ${formatMoney(e.amount, e.currency)} · ${e.date.split("-").reverse().join("/")}`,
        `Pagó: ${who}`,
        "",
        "Se saca también de las cuentas de todos (y de tu tarjeta o cuenta, si lo pagaste vos).",
      ]),
      remove: { vaquitaId: v.id, expenseId: e.id },
    };
    return { ok: true, message: BUILT };
  }

  if (name === "add_vaquita_members") {
    const parsed = addSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const r = resolveVaquita(list, p.vaquita);
    if ("error" in r) return r;
    const v = r.v;
    const members: MemberInput[] = [];
    const lines: string[] = [];
    const inVaquita = (n: string) => v.members.find((m) => norm(m.name) === norm(n) || norm(firstName(m.name)) === norm(n));
    for (const raw of p.people ?? []) {
      if (ME_WORDS.has(norm(raw))) continue;
      const byNick = ctx.people.filter((x) => x.nicknames.some((nn) => norm(nn) === norm(raw)));
      const hit = byNick.length === 1 ? { hit: byNick[0] } : pickByName(ctx.people, raw, (x) => x.name);
      if ("many" in hit) return { error: `"${raw}" coincide con ${hit.many.map((x) => x.name).join(", ")}. Preguntale cuál.` };
      if ("hit" in hit) {
        const person = hit.hit;
        if (person.isApp && v.uids.includes(person.ref.slice(2))) return { error: `${person.name} ya está en «${v.name}».` };
        const offline = person.isApp ? v.members.find((m) => !m.uid && linkScore(m, person) > 0) : undefined;
        if (offline) {
          return { error: `${person.name} parece ser «${offline.name}» (sin app) de la vaquita: preguntale si es el mismo y, si es, usá link_vaquita_member en vez de sumarlo.` };
        }
        if (!person.isApp && inVaquita(person.name)) return { error: `${person.name} ya está en «${v.name}».` };
        members.push({ ref: person.ref });
        lines.push(`• *${person.name}*${person.isApp ? " (usa La Libreta: la va a ver)" : " (sin la app)"}`);
        continue;
      }
      if (inVaquita(raw)) return { error: `"${raw}" ya está en «${v.name}» (${inVaquita(raw)!.name}).` };
      members.push({ name: raw });
      lines.push(`• *${raw}* (sin la app: lo cargan ustedes)`);
    }
    for (const c of p.contacts ?? []) {
      const q = parseContactQuery(c.contact);
      if (!q) return { error: `"${c.contact}" no es un WhatsApp ni un email válido.` };
      const found = await findUserByQuery(q);
      const shownQ = q.kind === "phone" ? formatPhone(q.value) : q.value;
      if (found) {
        if (found.uid === uid) continue;
        if (v.uids.includes(found.uid)) return { error: `${profileName(found.profile)} ya está en «${v.name}».` };
        members.push({ q: q.value, name: profileName(found.profile) });
        lines.push(`• *${profileName(found.profile)}* (${shownQ}): usa La Libreta; si no son contactos, le llega tu solicitud y la ve cuando acepta`);
      } else {
        if (!c.name) return { error: `${shownQ} no usa La Libreta: preguntale cómo se llama.` };
        members.push({ q: q.value, name: c.name });
        lines.push(
          `• *${c.name}* (${shownQ}): no usa La Libreta; ${q.kind === "email" ? "le mandamos un mail de invitación" : "queda invitado"} y se vincula cuando se suma`,
        );
      }
    }
    if (!members.length) return { error: "¿A quién sumo? Pedile el nombre (o su WhatsApp/email)." };
    ctx.proposedDraft = {
      ...draftBase("add", v.name, `🐮 *Sumar a «${v.name}»*`, lines),
      add: { vaquitaId: v.id, members },
    };
    const phoneInvites = (p.contacts ?? []).some((c) => parseContactQuery(c.contact)?.kind === "phone");
    return { ok: true, message: phoneInvites ? `${BUILT} Si alguno por WhatsApp no usa La Libreta, después de confirmar ofrecele invitarlo (contact_info invite).` : BUILT };
  }

  if (name === "link_vaquita_member") {
    const parsed = linkSchema.safeParse(args);
    if (!parsed.success) return issues(parsed.error);
    const p = parsed.data;
    const r = resolveVaquita(list, p.vaquita);
    if ("error" in r) return r;
    const v = r.v;
    const m = findMember(v, p.member, uid, ctx.people);
    if ("error" in m) return m;
    if (m.member.uid) return { error: `${m.member.name} ya usa la app en «${v.name}»: no hace falta vincularlo.` };
    if (p.contact && !p.person) {
      const q = parseContactQuery(p.contact);
      if (!q) return { error: "No es un WhatsApp ni un email válido. Pedile el número con característica o el email." };
      const found = await findUserByQuery(q);
      const shownQ = q.kind === "phone" ? formatPhone(q.value) : q.value;
      ctx.proposedDraft = {
        ...draftBase("link", v.name, `🔗 *Vincular en «${v.name}»*`, [
          found
            ? `*${m.member.name}* (sin app) es *${profileName(found.profile)}* (${shownQ}), que usa La Libreta.`
            : `*${m.member.name}* (sin app): ${shownQ} todavía no usa La Libreta.`,
          "",
          found
            ? "Si no son contactos, le llega tu solicitud y queda vinculado cuando acepta."
            : q.kind === "email"
              ? "Le mandamos un mail de invitación y queda vinculado cuando se suma y acepta."
              : "Queda anotado: cuando se sume a La Libreta con ese WhatsApp y acepte, queda vinculado.",
        ]),
        link: { vaquitaId: v.id, memberId: m.member.id, q: q.value, name: found ? profileName(found.profile) : m.member.name },
      };
      return {
        ok: true,
        message: found || q.kind === "email" ? BUILT : `${BUILT} Después de confirmar, ofrecele invitarlo por WhatsApp (contact_info invite).`,
      };
    }
    const pool = linkablePeople(v, ctx.people);
    if (!pool.length) {
      return { error: "No tiene a nadie de la app para vincular: primero tiene que agregarlo como contacto (contact_info connect) y que acepte." };
    }
    let person: AgentPerson | undefined;
    if (p.person) {
      person = pool.find((x) => x.ref === p.person);
      if (!person) {
        const byNick = pool.filter((x) => x.nicknames.some((nn) => norm(nn) === norm(p.person!)));
        const hit = byNick.length === 1 ? { hit: byNick[0] } : pickByName(pool, p.person, (x) => x.name);
        if ("many" in hit) return { error: `"${p.person}" coincide con ${hit.many.map((x) => x.name).join(", ")}. Preguntale cuál.` };
        if ("none" in hit) return { error: `"${p.person}" no está entre los que usan la app y no están en la vaquita: ${pool.map((x) => x.name).join(", ")}.` };
        person = hit.hit;
      }
    } else {
      const exact = pool.filter((x) => linkScore(m.member, x) === 2);
      const close = exact.length ? exact : pool.filter((x) => linkScore(m.member, x) === 1);
      if (close.length !== 1) {
        return { error: `¿Con quién de la app es ${m.member.name}? Pueden ser: ${pool.map((x) => x.name).join(", ")}. Preguntale.` };
      }
      person = close[0];
    }
    ctx.proposedDraft = {
      ...draftBase("link", v.name, `🔗 *Vincular en «${v.name}»*`, [
        `*${m.member.name}* (sin app) es *${person.name}*, que usa La Libreta.`,
        "",
        "Va a ver la vaquita y su parte va a sus gastos. Lo que ya estaba cargado no cambia.",
      ]),
      link: { vaquitaId: v.id, memberId: m.member.id, ref: person.ref, name: person.name },
    };
    return { ok: true, message: BUILT };
  }

  return { error: `Herramienta desconocida: ${name}` };
};
