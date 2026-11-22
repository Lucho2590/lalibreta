import "server-only";

import { randomUUID } from "node:crypto";
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
  firstName,
  summarizeVaquita,
  toVaquitaCurrency,
  unitOfMember,
  vaquitaUnits,
  type Vaquita,
  type VaquitaMember,
  type VaquitaSplitMode,
} from "@/lib/domain/vaquitas";
import { formatMoney } from "@/lib/format";
import type { ServerAccountInfo } from "../queries-admin";
import type { AgentPerson } from "../people";
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
        'Arma un gasto de una vaquita para confirmar ("anotá en la vaquita del viaje: nafta 40 mil, pagué yo en efectivo", "en la cena pagó Lean 60 lucas"). Si no dice cómo se divide, se divide como el último gasto de esa vaquita (o entre todos). NO uses propose_transaction para gastos de una vaquita: este ya lo carga en sus cuentas.',
      parameters: {
        type: "object",
        properties: {
          vaquita: VAQUITA_REF,
          description: { type: "string", description: 'Qué fue ("Nafta", "Cena", "Súper")' },
          amount: { type: "number" },
          currency: { type: "string", enum: CURRENCIES, description: 'Moneda del gasto (por defecto, la de la vaquita). Si dice pesos, "lucas" o "mil" en una vaquita en otra moneda, ARS.' },
          date: { type: "string", description: "YYYY-MM-DD (por defecto hoy)" },
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
          rate: { type: "number", description: "Cotización a mano: unidades de la moneda de la vaquita por 1 de currency (solo si la dijo)" },
        },
        required: ["description", "amount"],
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
const expenseSchema = z.object({
  vaquita: optStr,
  description: z.string().trim().min(1).max(80),
  amount: z.number().positive().max(10_000_000_000),
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
});
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
  const tries = [
    (x: T) => norm(nameOf(x)) === n,
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

const findMember = (v: Vaquita, who: string | undefined, uid: string): { member: VaquitaMember } | { error: string } => {
  const me = v.members.find((m) => m.uid === uid);
  if (!who || ME_WORDS.has(norm(who)) || US_WORDS.has(norm(who))) {
    return me ? { member: me } : { error: "El usuario no está en esa vaquita." };
  }
  const r = pickByName(v.members, who, (m) => m.name);
  if ("hit" in r) return { member: r.hit };
  if ("many" in r) return { error: `"${who}" coincide con ${r.many.map((m) => m.name).join(", ")}. Preguntale cuál.` };
  return { error: `"${who}" no está en «${v.name}». Están: ${v.members.map((m) => m.name).join(", ")}.` };
};

/** Una parte (familia o persona suelta) por nombre de familia o de alguien de ella. */
const findUnit = (v: Vaquita, who: string, uid: string): { unitId: string } | { error: string } => {
  const units = vaquitaUnits(v);
  const unitOf = unitOfMember(units);
  const families = units.filter((u) => u.isFamily);
  if (!US_WORDS.has(norm(who)) && !ME_WORDS.has(norm(who))) {
    const f = pickByName(families, who, (u) => u.name);
    if ("hit" in f) return { unitId: f.hit.id };
  }
  const m = findMember(v, who, uid);
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
      const r = pickByName(ctx.people, raw, (x) => x.name);
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
    const lines = [`Moneda: ${currency}`, "", "*Integrantes*", "• Vos", ...members.map((m) => `• ${m.label}`)];
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
    const amount = round2(p.amount);
    const currency = p.currency ?? v.currency;
    const date = p.date ?? todayYMD();

    // Quién pagó.
    const paidBy: Record<string, number> = {};
    if (p.payers?.length) {
      for (const x of p.payers) {
        const m = findMember(v, x.who, uid);
        if ("error" in m) return m;
        paidBy[m.member.id] = round2((paidBy[m.member.id] ?? 0) + x.amount);
      }
      const sum = round2(Object.values(paidBy).reduce((s, a) => s + a, 0));
      if (Math.abs(sum - amount) >= 0.01) return { error: `Lo que pagaron suma ${sum} y el gasto es ${amount}. Preguntale.` };
    } else {
      const m = findMember(v, p.paidBy, uid);
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
        const m = findMember(v, x.who, uid);
        if ("error" in m) return m;
        amounts[m.member.id] = round2((amounts[m.member.id] ?? 0) + x.amount);
      }
      among = Object.keys(amounts);
    } else if (p.splitAmong?.length || p.splitMode) {
      mode = p.splitMode ?? (units.some((u) => u.isFamily) ? "families" : "people");
      if (mode === "families") {
        among = [];
        for (const who of p.splitAmong ?? units.map((u) => u.id)) {
          const u = units.some((x) => x.id === who) ? { unitId: who } : findUnit(v, who, uid);
          if ("error" in u) return u;
          if (!among.includes(u.unitId)) among.push(u.unitId);
        }
      } else {
        among = [];
        for (const who of p.splitAmong ?? v.members.map((m) => m.id)) {
          // "nosotros" / una familia: todos los de esa parte.
          if (US_WORDS.has(norm(who)) || "hit" in pickByName(units.filter((u) => u.isFamily), who, (u) => u.name)) {
            const u = findUnit(v, who, uid);
            if ("error" in u) return u;
            for (const id of units.find((x) => x.id === u.unitId)?.memberIds ?? []) if (!among.includes(id)) among.push(id);
            continue;
          }
          const m = v.members.some((x) => x.id === who) ? { member: v.members.find((x) => x.id === who)! } : findMember(v, who, uid);
          if ("error" in m) return m;
          if (!among.includes(m.member.id)) among.push(m.member.id);
        }
      }
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

    const rate = await rateFor(currency, v.currency, p.rate);
    if (!rate) return { error: `No conseguí la cotización de ${currency} a ${v.currency}. Preguntale a cuánto.` };

    // Con qué pagó el usuario (si pagó).
    const iPaid = !!me && (paidBy[me.id] ?? 0) > 0;
    let myLeg: ExpenseInput["myLeg"] = null;
    let accountText = "";
    if (iPaid && !p.noAccount) {
      const a = pickMyAccount(ctx.accounts, currency, p.accountId, true);
      if ("error" in a) return a;
      const installments = a.account.type === "credit" ? (p.installments ?? 1) : 1;
      myLeg = { accountId: a.account.id, installments };
      accountText = `${a.account.name}${installments > 1 ? ` en ${installments} cuotas` : ""}`;
    } else if (iPaid) {
      accountText = "no lo anoto en tus cuentas";
    }

    const shareInFamily = !!p.shareInFamily;
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
      `*${p.description}* · ${formatMoney(amount, currency)}${currency !== v.currency ? ` (= ${formatMoney(toVaquitaCurrency(amount, rate), v.currency)})` : ""}`,
      `Pagó: ${payersText}${accountText ? ` · ${accountText}` : ""}`,
      `Se divide ${splitText}`,
      ...(shareInFamily ? ["Compartido en la familia: cada uno lo ve en sus gastos"] : []),
      `Fecha: ${date.split("-").reverse().join("/")}`,
      "",
      `Va a tus gastos: *${formatMoney(myPart, currency)}*`,
    ];
    ctx.proposedDraft = {
      ...draftBase("expense", v.name, `🐮 *Gasto en «${v.name}»*`, lines),
      expense: {
        vaquitaId: v.id,
        description: p.description,
        date,
        amount,
        currency,
        rate: currency === v.currency ? null : rate,
        paidBy,
        splitMode: mode,
        splitAmong: among,
        ...(amounts ? { amounts } : {}),
        shareInFamily,
        myLeg,
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
    const from = findMember(v, p.from, uid);
    if ("error" in from) return from;
    const to = findMember(v, p.to, uid);
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

  return { error: `Herramienta desconocida: ${name}` };
};
