import "server-only";

import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { ensureOfflineContact, saveContactInfoAdmin, type AgentPerson } from "../people";
import { formatPayAlias, personMatchScore } from "@/lib/domain/contact-info";

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
        'Ficha de una persona de "Personas". save: guarda lo que el usuario dice de alguien ("el alias de Juan es juan.perez.mp", "a Ornella decile Orne", "agendá a Pedro, su CBU es …"). send_alias: le manda el alias/CBU de alguien para transferirle ("pasame el alias de Orne", "¿a dónde le transfiero a Juan?").',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["save", "send_alias"] },
          person: { type: "string", description: "person de Personas" },
          newName: { type: "string", description: "save: alguien SIN la app que no está en Personas (se agrega)" },
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
  action: z.enum(["save", "send_alias"]),
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

export const runContactsTool = async (
  ctx: ContactsToolContext,
  _name: string,
  args: unknown,
): Promise<Record<string, unknown>> => {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  const a = parsed.data;

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
      return { error: `${found.error} Si no usa la app, usá newName; si la usa, que se conecten desde Contactos.` };
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
    return {
      ok: true,
      person: who.ref,
      name: saved.name,
      nicknames: saved.nicknames,
      payAliases: saved.payAliases.map(formatPayAlias),
      note: "Guardado en su ficha (Contactos). Contale en una línea qué quedó guardado.",
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "No se pudo guardar." };
  }
};
