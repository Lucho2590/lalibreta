import "server-only";

import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { isYMD } from "../time";
import { tryGetAppRates } from "../fx";
import {
  ListError,
  addItemsAdmin,
  createNodeAdmin,
  deleteNodeAdmin,
  getNodeFor,
  loadActor,
  loadTreeFor,
  removeItemsAdmin,
  setItemsDoneAdmin,
  shareListNode,
  updateNodeAdmin,
  type ListActor,
} from "../lists";
import { resolvePeople } from "./agenda-tool";
import {
  childrenOf,
  dueLabel,
  matchByName,
  myRole,
  nodePath,
  nodeSummary,
  personName,
  roleLabel,
  sortedItems,
  type ListItem,
  type ListNode,
} from "@/lib/domain/list-model";
import { CURRENCIES, type Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

/**
 * Listas por WhatsApp: armar listas y grupos, agregar/tachar ítems, ver cuánto
 * se gastó contra el tope y compartirlas. Los gastos de un ítem se cargan con
 * propose_transaction (parámetro listItem).
 */

const itemSchemaJson = {
  type: "object",
  properties: {
    title: { type: "string", description: 'Qué es ("Leche", "Juan Pérez", "Torta")' },
    quantity: { type: "string", description: 'Cantidad si la dijo ("2 kg", "x3")' },
    estimatedAmount: { type: "number", description: "Precio estimado si lo dijo, en la moneda de la lista" },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const LIST_REF = {
  type: "string",
  description: 'id (de get_lists) o nombre de la lista o grupo ("super", "Mi cumple"). Si hay dos con el mismo nombre, usá el id.',
} as const;

export const LISTS_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "get_lists",
      description:
        "Las listas y grupos del usuario (propios y compartidos con él): lo hecho, lo gastado contra el tope, la fecha de finalización y con quién está compartida. Con list, el detalle de una lista (sus ítems) o de un grupo (lo que tiene adentro).",
      parameters: {
        type: "object",
        properties: { list: LIST_REF },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_list",
      description:
        "Crea una lista (de cosas: compras, invitados, pendientes…) o un grupo de listas (ej. \"Mi cumple\" con \"Invitados\" y \"Compras\" adentro). Se guarda directo. Adentro de un grupo hereda con quién está compartido.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["list", "group"], description: "list por defecto" },
          title: { type: "string" },
          parent: { ...LIST_REF, description: "Grupo donde va (opcional; id o nombre)" },
          dueDate: { type: "string", description: "Fecha de finalización YYYY-MM-DD (opcional)" },
          budget: { type: "number", description: 'Máximo a gastar (opcional): "tope de 300 lucas" → 300000' },
          currency: { type: "string", enum: CURRENCIES, description: "Moneda del tope (ARS por defecto)" },
          items: { type: "array", items: itemSchemaJson, description: "Ítems iniciales (solo listas)" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_list",
      description: "Cambia el nombre, la fecha de finalización o el tope de una lista o grupo. Solo los campos que cambian.",
      parameters: {
        type: "object",
        properties: {
          list: LIST_REF,
          title: { type: "string" },
          dueDate: { type: "string", description: 'YYYY-MM-DD, o "none" para sacarla' },
          budget: { type: "number", description: "Nuevo tope; 0 para sacarlo" },
          currency: { type: "string", enum: CURRENCIES },
        },
        required: ["list"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_list_items",
      description:
        'Agrega uno o varios ítems a una lista ("agregá leche y pan a la del super", "sumá a Juan a los invitados"). Lo que ya está sin tachar no se repite. Agregar un ítem NO es un gasto.',
      parameters: {
        type: "object",
        properties: {
          list: LIST_REF,
          items: { type: "array", items: itemSchemaJson, minItems: 1 },
        },
        required: ["list", "items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_list_items",
      description:
        'Tacha (o destacha con done=false) ítems de una lista ("tachá la leche", "ya confirmó Juan"). Si además dice que lo pagó y cuánto, el gasto va con propose_transaction + listItem (eso ya lo tacha).',
      parameters: {
        type: "object",
        properties: {
          list: LIST_REF,
          items: { type: "array", items: { type: "string" }, description: "Nombres o ids de los ítems", minItems: 1 },
          done: { type: "boolean", description: "true (default) tacha; false destacha" },
        },
        required: ["list", "items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_list_items",
      description: "Saca ítems de una lista (los gastos que tengan siguen en los movimientos).",
      parameters: {
        type: "object",
        properties: {
          list: LIST_REF,
          items: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["list", "items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_list",
      description:
        "Borra una lista o un grupo con todo lo de adentro. ANTES confirmá con el usuario si tiene ítems, listas adentro o está compartida.",
      parameters: {
        type: "object",
        properties: { list: LIST_REF },
        required: ["list"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "share_list",
      description:
        "Comparte una lista o grupo (compartir un grupo comparte todo lo de adentro) con contactos o emails, para ver o para editar, o deja de compartirla con alguien. Solo el dueño puede. A los nuevos les llega un aviso.",
      parameters: {
        type: "object",
        properties: {
          list: LIST_REF,
          people: {
            type: "array",
            items: {
              type: "object",
              properties: {
                who: { type: "string", description: "Nombre de un contacto o email" },
                role: { type: "string", enum: ["view", "edit"], description: "edit (default) puede tachar, agregar y cargar gastos; view solo ve" },
              },
              required: ["who"],
              additionalProperties: false,
            },
          },
          remove: { type: "array", items: { type: "string" }, description: "Con quién deja de compartirla (nombres o emails)" },
        },
        required: ["list"],
        additionalProperties: false,
      },
    },
  },
];

export const LISTS_TOOL_NAMES = new Set(LISTS_TOOLS.map((t) => t.function.name));

// ---------- Schemas ----------

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const itemSchema = z.object({
  title: z.string().trim().min(1).max(120),
  quantity: optStr,
  estimatedAmount: z.number().positive().max(1_000_000_000).optional(),
});

const getSchema = z.object({ list: optStr });
const createSchema = z.object({
  kind: z.enum(["list", "group"]).optional(),
  title: z.string().trim().min(1).max(80),
  parent: optStr,
  dueDate: optStr.refine((v) => !v || isYMD(v), "dueDate debe ser YYYY-MM-DD"),
  budget: z.number().min(0).max(10_000_000_000).optional(),
  currency: z.enum(CURRENCIES).optional(),
  items: z.array(itemSchema).max(100).optional(),
});
const updateSchema = z.object({
  list: z.string().min(1),
  title: optStr,
  dueDate: optStr.refine((v) => !v || v === "none" || isYMD(v), "dueDate debe ser YYYY-MM-DD o none"),
  budget: z.number().min(0).max(10_000_000_000).optional(),
  currency: z.enum(CURRENCIES).optional(),
});
const addSchema = z.object({ list: z.string().min(1), items: z.array(itemSchema).min(1).max(100) });
const checkSchema = z.object({
  list: z.string().min(1),
  items: z.array(z.string().min(1)).min(1).max(100),
  done: z.boolean().optional(),
});
const removeSchema = z.object({ list: z.string().min(1), items: z.array(z.string().min(1)).min(1).max(100) });
const deleteSchema = z.object({ list: z.string().min(1) });
const shareSchema = z.object({
  list: z.string().min(1),
  people: z.array(z.object({ who: z.string().min(1), role: z.enum(["view", "edit"]).optional() })).max(20).optional(),
  remove: z.array(z.string().min(1)).max(20).optional(),
});

// ---------- Helpers ----------

type Tree = Awaited<ReturnType<typeof loadTreeFor>>;

/** Encuentra una lista o grupo por id o por nombre (o "Grupo › Lista"). */
export const resolveNode = (
  tree: Tree,
  ref: string,
  prefer?: "list" | "group",
): { node: ListNode } | { error: string } => {
  const byId = tree.byId.get(ref.trim());
  if (byId) return { node: byId };
  let pool = tree.nodes;
  let q = ref;
  // "Mi cumple › Compras" / "compras del cumple"
  const parts = ref.split(/›|>|\//).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const parents = matchByName(tree.nodes, parts[0]);
    const ids = new Set(parents.flatMap((p) => [p.id, ...tree.descendants(p.id).map((d) => d.id)]));
    pool = tree.nodes.filter((n) => ids.has(n.id));
    q = parts.at(-1)!;
  }
  let matches = matchByName(pool, q);
  if (matches.length > 1 && prefer) {
    const preferred = matches.filter((m) => m.kind === prefer);
    if (preferred.length >= 1) matches = preferred;
  }
  if (matches.length === 1) return { node: matches[0] };
  if (matches.length > 1) {
    return {
      error: `"${ref}" coincide con varias: ${matches
        .map((m) => `${nodePath(tree.byId, m)} (id ${m.id}, ${m.kind === "group" ? "grupo" : "lista"})`)
        .join("; ")}. Preguntale cuál y usá el id.`,
    };
  }
  const all = tree.nodes.map((n) => nodePath(tree.byId, n));
  return {
    error: `No encontré "${ref}".${all.length ? ` Tiene: ${all.join("; ")}.` : " No tiene listas todavía."} Si quiere una nueva, usá create_list.`,
  };
};

/** Encuentra ítems por id o nombre (prefiere los no tachados). */
export const resolveItems = (
  node: ListNode,
  refs: string[],
  preferDone?: boolean,
): { items: ListItem[]; notFound: string[]; ambiguous: string[] } => {
  const all = sortedItems(node);
  const items: ListItem[] = [];
  const notFound: string[] = [];
  const ambiguous: string[] = [];
  for (const ref of refs) {
    const byId = node.items?.[ref];
    if (byId) {
      items.push(byId);
      continue;
    }
    let m = matchByName(all, ref);
    if (m.length > 1) {
      const narrowed = m.filter((x) => x.done === !!preferDone);
      if (narrowed.length) m = narrowed;
    }
    if (m.length === 1) items.push(m[0]);
    else if (m.length > 1) ambiguous.push(`"${ref}" (${m.map((x) => x.title).join(", ")})`);
    else notFound.push(ref);
  }
  return { items: [...new Map(items.map((i) => [i.id, i])).values()], notFound, ambiguous };
};

const money = (n: number, c: Currency) => formatMoney(n, c);

/** Resumen corto de un nodo para el modelo. */
const describe = (
  tree: Tree,
  node: ListNode,
  me: ListActor,
  rates: Partial<Record<Currency, number>> | null,
) => {
  const s = nodeSummary(node, tree.index, rates);
  const role = myRole(node, me);
  const others = node.members.filter((m) => m.uid !== me.uid && m.email !== me.email);
  return {
    id: node.id,
    kind: node.kind === "group" ? "grupo" : "lista",
    path: nodePath(tree.byId, node),
    ...(node.kind === "group" ? { inside: childrenOf(tree.index, node.id).map((k) => k.title) } : {}),
    ...(s.items.total ? { done: `${s.items.done}/${s.items.total}` } : {}),
    ...(s.spent > 0 ? { spent: money(s.spent, node.currency) } : {}),
    ...(node.budget
      ? {
          budget: money(node.budget, node.currency),
          [s.status.over ? "overBy" : "left"]: money(Math.abs(s.status.remaining ?? 0), node.currency),
        }
      : {}),
    ...(s.projected > s.spent ? { projected: money(s.projected, node.currency) } : {}),
    ...(node.dueDate ? { due: `${node.dueDate} (${dueLabel(node.dueDate)})` } : {}),
    ...(others.length ? { sharedWith: others.map((m) => `${personName(m)} (${roleLabel(m.role)})`) } : {}),
    ...(role && role !== "owner" ? { myAccess: roleLabel(role), owner: personName({ displayName: node.ownerDisplayName, email: node.ownerEmail }) } : {}),
  };
};

const describeItem = (item: ListItem, currency: Currency) => {
  const paid = Object.values(item.expenses ?? {});
  return {
    id: item.id,
    title: item.title,
    done: item.done,
    ...(item.quantity ? { quantity: item.quantity } : {}),
    ...(item.estimatedAmount ? { estimated: money(item.estimatedAmount, currency) } : {}),
    ...(paid.length ? { paid: paid.map((e) => `${money(e.amount, e.currency)}${e.byName ? ` (${e.byName.split(" ")[0]})` : ""}`) } : {}),
  };
};

const rates = async () => (await tryGetAppRates())?.rates ?? null;

// ---------- Ejecutor ----------

export const runListsTool = async (
  uid: string,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> => {
  const issues = (e: z.ZodError) => ({ error: e.issues.map((i) => i.message).join("; ") });
  const me = await loadActor(uid);

  try {
    if (name === "get_lists") {
      const parsed = getSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const [tree, fx] = await Promise.all([loadTreeFor(me), rates()]);
      if (!parsed.data.list) {
        if (tree.nodes.length === 0) return { lists: [], note: "No tiene listas. Se crean con create_list." };
        // Ordenadas como árbol: cada raíz seguida de lo de adentro.
        const ordered: ListNode[] = [];
        for (const r of tree.index.get("") ?? []) ordered.push(r, ...tree.descendants(r.id));
        return { lists: ordered.map((n) => describe(tree, n, me, fx)) };
      }
      const r = resolveNode(tree, parsed.data.list);
      if ("error" in r) return r;
      const node = r.node;
      return {
        ...describe(tree, node, me, fx),
        ...(node.kind === "list"
          ? { items: sortedItems(node).map((i) => describeItem(i, node.currency)) }
          : { children: childrenOf(tree.index, node.id).map((k) => describe(tree, k, me, fx)) }),
        ...(node.notes ? { notes: node.notes } : {}),
      };
    }

    if (name === "create_list") {
      const parsed = createSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const p = parsed.data;
      const kind = p.kind ?? "list";
      const tree = await loadTreeFor(me);
      let parentId: string | null = null;
      if (p.parent) {
        const r = resolveNode(tree, p.parent, "group");
        if ("error" in r) return r;
        if (r.node.kind !== "group") {
          return { error: `"${r.node.title}" es una lista, no un grupo. Para agrupar, creá primero el grupo.` };
        }
        parentId = r.node.id;
      }
      // El modelo a veces repite la llamada: si ya existe una igual en el mismo lugar, no se duplica.
      const same = tree.nodes.find(
        (n) =>
          n.kind === kind &&
          (n.parentId ?? null) === parentId &&
          n.title.trim().toLowerCase() === p.title.trim().toLowerCase(),
      );
      if (same) {
        if (p.items?.length && same.kind === "list") {
          const r = await addItemsAdmin(me, same.id, p.items);
          return { ok: true, id: same.id, alreadyExisted: true, added: r.added, alreadyThere: r.already };
        }
        return { ok: true, id: same.id, alreadyExisted: true, note: "Ya existía (no se duplicó)." };
      }
      const node = await createNodeAdmin(
        me,
        parentId,
        kind,
        {
          title: p.title,
          dueDate: p.dueDate ?? null,
          budget: p.budget || null,
          currency: p.currency ?? (parentId ? tree.byId.get(parentId)?.currency : undefined) ?? "ARS",
        },
        p.items ?? [],
      );
      const path = parentId ? `${nodePath(tree.byId, tree.byId.get(parentId)!)} › ${node.title}` : node.title;
      const parent = parentId ? tree.byId.get(parentId) : null;
      return {
        ok: true,
        id: node.id,
        path,
        items: p.items?.length ?? 0,
        ...(parent && parent.members.length > 1
          ? { sharedWith: parent.members.filter((m) => m.uid !== uid).map(personName), note: "Hereda con quién está compartido el grupo." }
          : {}),
        appUrl: `/listas/${node.id}`,
      };
    }

    if (name === "update_list") {
      const parsed = updateSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const p = parsed.data;
      const tree = await loadTreeFor(me);
      const r = resolveNode(tree, p.list);
      if ("error" in r) return r;
      const node = await updateNodeAdmin(me, r.node.id, {
        ...(p.title ? { title: p.title } : {}),
        ...(p.dueDate ? { dueDate: p.dueDate === "none" ? null : p.dueDate } : {}),
        ...(p.budget !== undefined ? { budget: p.budget || null } : {}),
        ...(p.currency ? { currency: p.currency } : {}),
      });
      return {
        ok: true,
        id: node.id,
        title: node.title,
        due: node.dueDate ?? "sin fecha",
        budget: node.budget ? money(node.budget, node.currency) : "sin tope",
      };
    }

    if (name === "add_list_items") {
      const parsed = addSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const tree = await loadTreeFor(me);
      const r = resolveNode(tree, parsed.data.list, "list");
      if ("error" in r) return r;
      if (r.node.kind === "group") {
        const kids = childrenOf(tree.index, r.node.id).filter((k) => k.kind === "list");
        return {
          error: `"${r.node.title}" es un grupo. ${kids.length ? `Sus listas: ${kids.map((k) => `${k.title} (id ${k.id})`).join(", ")}. Preguntale en cuál, o usá la que corresponda.` : "No tiene listas adentro: creá una con create_list (parent = el grupo)."}`,
        };
      }
      const res = await addItemsAdmin(me, r.node.id, parsed.data.items);
      return {
        ok: true,
        list: nodePath(tree.byId, r.node),
        added: res.added,
        ...(res.already.length ? { alreadyThere: res.already } : {}),
        pending: Object.values(res.node.items ?? {}).filter((i) => !i.done).length + res.added.length,
      };
    }

    if (name === "check_list_items" || name === "remove_list_items") {
      const parsed = (name === "check_list_items" ? checkSchema : removeSchema).safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const p = parsed.data as z.infer<typeof checkSchema>;
      const tree = await loadTreeFor(me);
      const r = resolveNode(tree, p.list, "list");
      if ("error" in r) return r;
      if (r.node.kind !== "list") return { error: `"${r.node.title}" es un grupo: decime en qué lista.` };
      const done = p.done ?? true;
      const found = resolveItems(r.node, p.items, name === "check_list_items" ? !done : undefined);
      if (found.ambiguous.length) return { error: `Hay más de uno: ${found.ambiguous.join("; ")}. Preguntale cuál.` };
      if (found.items.length === 0) {
        return {
          error: `No encontré ${found.notFound.map((x) => `"${x}"`).join(", ")} en ${r.node.title}. Tiene: ${sortedItems(r.node)
            .map((i) => i.title)
            .join(", ") || "nada"}.`,
        };
      }
      const ids = found.items.map((i) => i.id);
      if (name === "check_list_items") await setItemsDoneAdmin(me, r.node.id, ids, done);
      else await removeItemsAdmin(me, r.node.id, ids);
      const fresh = (await getNodeFor(me, r.node.id)).node;
      const left = sortedItems(fresh).filter((i) => !i.done);
      return {
        ok: true,
        list: nodePath(tree.byId, r.node),
        [name === "check_list_items" ? (done ? "checked" : "unchecked") : "removed"]: found.items.map((i) => i.title),
        ...(found.notFound.length ? { notFound: found.notFound } : {}),
        pending: left.map((i) => i.title),
      };
    }

    if (name === "delete_list") {
      const parsed = deleteSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const tree = await loadTreeFor(me);
      const r = resolveNode(tree, parsed.data.list);
      if ("error" in r) return r;
      const n = await deleteNodeAdmin(me, r.node.id);
      return { ok: true, deleted: nodePath(tree.byId, r.node), nodes: n, note: "Los gastos cargados siguen en los movimientos." };
    }

    if (name === "share_list") {
      const parsed = shareSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const p = parsed.data;
      const tree = await loadTreeFor(me);
      const r = resolveNode(tree, p.list);
      if ("error" in r) return r;
      const node = r.node;
      if (node.ownerUid !== uid) return { error: "La lista es de otra persona: solo el dueño la puede compartir." };
      const people = await resolvePeople(uid, (p.people ?? []).map((x) => x.who));
      if ("error" in people) return people;
      const shares = [...(node.shares ?? [])];
      people.ok.forEach((inv, i) => {
        if (inv.email === me.email) return;
        const role = p.people?.[i]?.role ?? "edit";
        const idx = shares.findIndex((s) => s.email === inv.email);
        const next = { uid: inv.uid, email: inv.email, displayName: inv.displayName ?? null, photoURL: inv.photoURL ?? null, role };
        if (idx >= 0) shares[idx] = { ...shares[idx], role };
        else shares.push(next);
      });
      const removed: string[] = [];
      for (const who of p.remove ?? []) {
        const q = who.trim().toLowerCase();
        const idx = shares.findIndex(
          (s) => s.email === q || matchByName([{ title: personName(s) }], who).length === 1,
        );
        if (idx >= 0) removed.push(personName(shares.splice(idx, 1)[0]));
      }
      const res = await shareListNode(me, node.id, shares);
      const fresh = (await getNodeFor(me, node.id)).node;
      return {
        ok: true,
        list: nodePath(tree.byId, node),
        sharedWith: fresh.members.filter((m) => m.uid !== uid).map((m) => `${personName(m)} (${roleLabel(m.role)})`),
        ...(removed.length ? { removed } : {}),
        notified: res.notified + res.emailed,
        ...(node.kind === "group" ? { note: "Vale para todo lo de adentro del grupo." } : {}),
      };
    }
  } catch (err) {
    if (err instanceof ListError) return { error: err.message };
    throw err;
  }

  return { error: `Herramienta desconocida: ${name}` };
};
