import "server-only";

import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { ensureOfflineContact, saveContactInfoAdmin, type AgentPerson } from "../people";
import {
  PeopleError,
  connectionState,
  findUserByQuery,
  loadProfile,
  requestConnectionTo,
} from "../connections";
import { sendEmailInvite } from "../invites";
import { formatPayAlias, personMatchScore } from "@/lib/domain/contact-info";
import { userRef } from "@/lib/domain/people";
import { formatPhone, inviteMessage, parseContactQuery, waMeLink, type ContactQuery } from "@/lib/domain/phone";

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "https://lalibreta.app";

/**
 * Ficha de las personas: guardar apodos y alias/CBU que dice el usuario, y
 * mandarle el alias de alguien para transferirle (en un mensaje aparte, fácil
 * de copiar).
 */
export const CONTACTS_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "contact_info",
      description:
        'Contactos. connect: agregar a alguien por su WhatsApp o su email ("agregá a 11 5555-1234", "agendá a juan@gmail.com"): si usa La Libreta le manda la solicitud para conectarse; si no, avisa para ofrecer invitarlo. invite: invitar a La Libreta a alguien que NO la usa (por WhatsApp: el sistema le manda un link para mandarle la invitación desde su WhatsApp; por email: le llega un mail). save: guarda lo que el usuario dice de alguien de Personas ("el alias de Juan es juan.perez.mp", "a Ornella decile Orne", "agendá a Pedro, su CBU es …"). send_alias: le manda el alias/CBU de alguien para transferirle ("pasame el alias de Orne", "¿a dónde le transfiero a Juan?").',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["connect", "invite", "save", "send_alias"] },
          contact: {
            type: "string",
            description: "connect/invite: su email o su número de WhatsApp tal cual lo escribió el usuario",
          },
          person: { type: "string", description: "person de Personas" },
          newName: {
            type: "string",
            description: "save: alguien SIN la app que no está en Personas (se agrega). invite: cómo se llama, si lo dijo",
          },
          name: { type: "string", description: "save: nombre nuevo (cómo lo quiere ver el usuario)" },
          addNicknames: {
            type: "array",
            items: { type: "string" },
            description: 'save: otras formas en que el usuario lo nombra ("Orne", "mi señora", "el Colo")',
          },
          removeNicknames: { type: "array", items: { type: "string" } },
          addPayAliases: {
            type: "array",
            description: "save: alias, CBU o CVU para transferirle",
            items: {
              type: "object",
              properties: {
                value: { type: "string", description: "El alias o CBU/CVU tal cual" },
                label: { type: "string", description: 'Banco o billetera, si lo dice ("MP", "Galicia")' },
              },
              required: ["value"],
              additionalProperties: false,
            },
          },
          removePayAliases: { type: "array", items: { type: "string" } },
          phone: { type: "string" },
          email: { type: "string", description: "Solo para alguien sin la app" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export const CONTACTS_TOOL_NAMES = new Set(CONTACTS_TOOLS.map((t) => t.function.name));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));
const strList = z.array(z.string().trim().max(60)).max(10).optional();

const schema = z.object({
  action: z.enum(["connect", "invite", "save", "send_alias"]),
  contact: z.string().trim().max(120).optional(),
  person: optStr,
  newName: z.string().trim().max(60).optional(),
  name: z.string().trim().max(60).optional(),
  addNicknames: strList,
  removeNicknames: strList,
  addPayAliases: z
    .array(z.object({ value: z.string().trim().min(1).max(80), label: z.string().trim().max(30).optional() }))
    .max(6)
    .optional(),
  removePayAliases: strList,
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(120).optional(),
});

interface ContactsToolContext {
  uid: string;
  people: AgentPerson[];
  outbox: string[];
}

/** Por ref, o por nombre/apodo si el modelo mandó el nombre en vez del ref. */
const findPerson = (people: AgentPerson[], q: string): AgentPerson | { error: string } => {
  const byRef = people.find((p) => p.ref === q);
  if (byRef) return byRef;
  const scored = people.map((p) => ({ p, s: personMatchScore([p.name, ...p.nicknames], q) }));
  const best = Math.max(0, ...scored.map((x) => x.s));
  const matches = best ? scored.filter((x) => x.s === best).map((x) => x.p) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { error: `"${q}" puede ser ${matches.map((p) => p.name).join(" o ")}. Preguntale cuál.` };
  return { error: `"${q}" no está en Personas.` };
};

const shown = (q: NonNullable<ContactQuery>) => (q.kind === "phone" ? formatPhone(q.value) : q.value);

/** Agregar por WhatsApp o email: si usa la app, solicitud; si no, avisar para invitarlo. */
const connectByContact = async (ctx: ContactsToolContext, raw: string): Promise<Record<string, unknown>> => {
  const q = parseContactQuery(raw);
  if (!q) return { error: "No es un email ni un WhatsApp válido. Pedile su email o su número con característica (ej. 11 5555-1234)." };
  const found = await findUserByQuery(q);
  if (!found) {
    return {
      ok: false,
      usesApp: false,
      contact: shown(q),
      note:
        q.kind === "phone"
          ? `${shown(q)} no usa La Libreta (ningún usuario tiene ese WhatsApp vinculado). Decíselo y ofrecele invitarlo por WhatsApp (action invite) o agendarlo sin app (save con newName y phone; pedile el nombre si no lo dijo). Si sabe que usa la app, que te pase su email.`
          : `${shown(q)} no usa La Libreta (nadie se registró con ese email). Decíselo y ofrecele mandarle un mail de invitación (action invite) o agendarlo sin app (save con newName y email; pedile el nombre si no lo dijo).`,
    };
  }
  const { state } = await connectionState(ctx.uid, found.uid);
  if (state === "self") return { error: "Ese es el propio usuario." };
  try {
    const r = await requestConnectionTo({ uid: ctx.uid }, found.uid);
    if (r.status === "accepted" && !ctx.people.some((p) => p.ref === userRef(found.uid))) {
      ctx.people.push({
        ref: userRef(found.uid),
        name: r.name,
        isApp: true,
        contactId: null,
        nicknames: [],
        payAliases: [],
        email: found.profile.email,
        displayName: found.profile.displayName,
      });
    }
    return {
      ok: true,
      usesApp: true,
      name: r.name,
      person: r.status === "accepted" ? userRef(found.uid) : undefined,
      note:
        state === "connected"
          ? `Ya estaban conectados: ${r.name} está en Personas.`
          : r.status === "accepted"
            ? `${r.name} ya le había mandado una solicitud: quedaron conectados (ya está en Personas para dividir gastos).`
            : state === "outgoing"
              ? `Ya le había mandado la solicitud a ${r.name}: falta que la acepte.`
              : `${r.name} usa La Libreta: le llegó la solicitud para conectarse. Cuando acepte, queda agendado y pueden dividir gastos. Contáselo en una línea.`,
    };
  } catch (err) {
    return { error: err instanceof PeopleError ? err.message : "No se pudo mandar la solicitud." };
  }
};

/** Invitar a La Libreta a alguien que no la usa. */
const inviteByContact = async (
  ctx: ContactsToolContext,
  raw: string,
  name?: string,
): Promise<Record<string, unknown>> => {
  const q = parseContactQuery(raw);
  if (!q) return { error: "No es un email ni un WhatsApp válido. Pedile su email o su número con característica." };
  if (await findUserByQuery(q)) return { error: "Esa persona ya usa La Libreta: usá action connect." };
  if (q.kind === "email") {
    try {
      await sendEmailInvite({ uid: ctx.uid }, q.value, name);
      return { ok: true, note: `Le mandamos el mail de invitación a ${q.value}. Contáselo en una línea.` };
    } catch (err) {
      return { error: err instanceof PeopleError ? err.message : "No se pudo mandar el mail." };
    }
  }
  const me = await loadProfile(ctx.uid);
  const link = waMeLink(q.value, inviteMessage(me.displayName, appUrl()));
  ctx.outbox.push(`Tocá el link y mandale la invitación a ${name?.trim() || shown(q)} desde tu WhatsApp 👇\n${link}`);
  return {
    ok: true,
    note: "El sistema le manda aparte un link que abre el chat con esa persona y la invitación ya escrita. Respondé solo una línea corta tipo \"Listo 👇\". NO repitas el link.",
  };
};

export const runContactsTool = async (
  ctx: ContactsToolContext,
  _name: string,
  args: unknown,
): Promise<Record<string, unknown>> => {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  const a = parsed.data;

  if (a.action === "connect" || a.action === "invite") {
    const raw = a.contact || a.phone || a.email;
    if (!raw) return { error: "Falta su email o su WhatsApp (contact)." };
    return a.action === "connect" ? connectByContact(ctx, raw) : inviteByContact(ctx, raw, a.newName || a.name);
  }

  if (a.action === "send_alias") {
    if (!a.person) return { error: "Falta la persona (person)." };
    const who = findPerson(ctx.people, a.person);
    if ("error" in who) return who;
    if (who.payAliases.length === 0) {
      return {
        ok: false,
        person: who.name,
        note: `No tiene alias ni CBU de ${who.name} cargado. Decíselo y que te lo pase si quiere guardarlo (o que lo cargue en Contactos).`,
      };
    }
    // Cada alias solo, en su propio mensaje: en WhatsApp se copia el mensaje entero.
    for (const p of who.payAliases) ctx.outbox.push(p.value);
    return {
      ok: true,
      person: who.name,
      aliases: who.payAliases.map(formatPayAlias),
      note:
        who.payAliases.length > 1
          ? `El sistema le manda cada alias en un mensaje aparte, justo después de tu respuesta. Respondé solo una línea corta tipo "Los alias de ${who.name} 👇 (${who.payAliases.map((p) => p.label || p.value).join(", ")})". NO repitas los alias.`
          : `El sistema le manda el alias en un mensaje aparte, justo después de tu respuesta. Respondé solo una línea corta tipo "El alias de ${who.name}${who.payAliases[0].label ? ` (${who.payAliases[0].label})` : ""} 👇". NO repitas el alias.`,
    };
  }

  // save
  let who: AgentPerson;
  if (a.person) {
    const found = findPerson(ctx.people, a.person);
    if ("error" in found) {
      return {
        error: `${found.error} Si no usa la app, usá newName; si la usa, pedile su email o su WhatsApp y usá action connect.`,
      };
    }
    who = found;
  } else if (a.newName) {
    const found = findPerson(ctx.people, a.newName);
    if (!("error" in found)) {
      who = found;
    } else {
      const ref = await ensureOfflineContact(ctx.uid, a.newName);
      who = { ref, name: a.newName, isApp: false, contactId: ref.slice(2), nicknames: [], payAliases: [] };
      ctx.people.push(who);
    }
  } else {
    return { error: "Falta la persona (person o newName)." };
  }

  const hasChange =
    a.name ||
    a.addNicknames?.length ||
    a.removeNicknames?.length ||
    a.addPayAliases?.length ||
    a.removePayAliases?.length ||
    a.phone !== undefined ||
    a.email !== undefined;
  if (!hasChange && !a.newName) return { error: "No hay nada para guardar." };

  try {
    const saved = await saveContactInfoAdmin(ctx.uid, who, {
      name: a.name,
      addNicknames: a.addNicknames,
      removeNicknames: a.removeNicknames,
      addPayAliases: a.addPayAliases,
      removePayAliases: a.removePayAliases,
      phone: a.phone,
      email: a.email,
    });
    // Para lo que siga en este mismo mensaje (ej. dividir un gasto con esa persona).
    Object.assign(who, { name: saved.name, nicknames: saved.nicknames, payAliases: saved.payAliases });
    // ¿El teléfono o el email que dio son de alguien que usa la app?
    let appUser: string | null = null;
    if (!who.isApp) {
      for (const raw of [a.phone, a.email]) {
        const q = raw ? parseContactQuery(raw) : null;
        const found = q ? await findUserByQuery(q) : null;
        if (found && found.uid !== ctx.uid) {
          appUser = found.profile.displayName || found.profile.email;
          break;
        }
      }
    }
    return {
      ok: true,
      person: who.ref,
      name: saved.name,
      nicknames: saved.nicknames,
      payAliases: saved.payAliases.map(formatPayAlias),
      note: appUser
        ? `Guardado en su ficha (Contactos). Ojo: ese ${a.phone ? "WhatsApp" : "email"} es de ${appUser}, que usa La Libreta. Contale qué quedó guardado y ofrecele conectarse (action connect con ese contact) para que pueda aceptar los gastos que le divida.`
        : "Guardado en su ficha (Contactos). Contale en una línea qué quedó guardado.",
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "No se pudo guardar." };
  }
};
