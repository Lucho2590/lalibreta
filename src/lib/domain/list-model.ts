import type { Timestamp } from "firebase/firestore";
import type { Currency } from "./types";
import type { FxRatesMap } from "./balance";
import { addDaysYMD, ymdAR } from "./activity-model";

/**
 * Listas: listas de cosas (el super, los invitados del cumple…) y grupos de
 * listas que se anidan sin límite ("Mi cumple" → "Invitados", "Compras").
 *
 * Cada grupo o lista es un doc de la colección de primer nivel `lists` (un
 * "nodo"). Se comparten por persona con permiso de ver o de editar; compartir
 * un grupo comparte todo lo que tiene adentro. Para que las reglas no tengan
 * que recorrer el árbol, cada nodo guarda el acceso EFECTIVO (el dueño + lo
 * compartido en él y en sus ancestros) en `members` y en los arrays de índice.
 *
 * Los ítems viven en un mapa dentro de la lista (`items.<id>`): así dos
 * personas pueden tildar a la vez sin pisarse (cada update toca su campo).
 * Los gastos de un ítem se cargan en la libreta de quien lo pagó y quedan
 * vinculados en `items.<id>.expenses.<uid>` (copia del monto, como la agenda).
 */
export const listsCollectionPath = (): string => "lists";

/**
 * Índice inverso gasto → ítem, en la libreta de quien tiene el movimiento:
 * `users/{uid}/listLinks/{transactionId}`. Va aparte (y no adentro del
 * movimiento) porque al editar un movimiento se reescribe el doc entero. Sirve
 * para que la lista se entere si el gasto se edita o se borra.
 */
export const listLinksCollectionPath = (uid: string): string => `users/${uid}/listLinks`;

export interface ListLink {
  listId: string;
  itemId: string;
  /** Clave del gasto en el ítem (`expenses.<byUid>`): quien lo cargó. */
  byUid: string;
  /** epoch ms */
  createdAt: number;
}

export type ListNodeKind = "group" | "list";
export type ListRole = "owner" | "edit" | "view";
export type ShareRole = Exclude<ListRole, "owner">;

export interface ListPerson {
  uid: string | null;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
}

/** Lo compartido EN este nodo (no lo heredado). */
export interface ListShare extends ListPerson {
  role: ShareRole;
}

/** Acceso efectivo a un nodo (dueño + compartido en él o en sus ancestros). */
export interface ListMember extends ListPerson {
  role: ListRole;
}

/** Gasto que cargó alguien para un ítem (va en su libreta, con su cuenta). */
export interface ListItemExpense {
  transactionId: string;
  amount: number;
  currency: Currency;
  byName?: string | null;
  /** Si lo dividió con otras personas. */
  sharedExpenseId?: string | null;
  /** epoch ms */
  createdAt: number;
}

export interface ListItem {
  id: string;
  title: string;
  done: boolean;
  doneBy?: string | null;
  doneByName?: string | null;
  /** epoch ms */
  doneAt?: number | null;
  /** "2 kg", "x3"… */
  quantity?: string | null;
  notes?: string | null;
  /** Lo que se calcula que sale, en la moneda de la lista. */
  estimatedAmount?: number | null;
  order: number;
  createdBy?: string | null;
  /** epoch ms */
  createdAt: number;
  /** Por uid de quien lo cargó. */
  expenses?: Record<string, ListItemExpense>;
}

export interface ListNode {
  id: string;
  kind: ListNodeKind;
  parentId: string | null;
  /** Dueño de la raíz (los nodos de adentro lo heredan). */
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName?: string | null;
  createdBy: string;
  title: string;
  emoji?: string | null;
  notes?: string | null;
  /** Fecha de finalización (opcional), "YYYY-MM-DD". */
  dueDate?: string | null;
  /** Tope de gasto (opcional), en `currency`. */
  budget?: number | null;
  currency: Currency;
  /** Orden entre hermanos. */
  order: number;
  shares: ListShare[];
  members: ListMember[];
  memberUids: string[];
  memberEmails: string[];
  editorUids: string[];
  editorEmails: string[];
  /** Solo en las listas. */
  items?: Record<string, ListItem>;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

/** Campos que puede tocar un editor desde el cliente (el resto va por el server). */
export const EDITABLE_NODE_FIELDS = [
  "title",
  "emoji",
  "notes",
  "dueDate",
  "budget",
  "currency",
  "order",
  "items",
  "updatedAt",
] as const;

export interface ListNodeInput {
  title: string;
  emoji?: string | null;
  notes?: string | null;
  dueDate?: string | null;
  budget?: number | null;
  currency?: Currency | null;
}

export interface ListItemInput {
  title: string;
  quantity?: string | null;
  notes?: string | null;
  estimatedAmount?: number | null;
}

const clean = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

const isYMD = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Normaliza lo que carga el usuario para un grupo o lista. */
export const nodeBaseFields = (input: ListNodeInput) => ({
  title: input.title.trim(),
  emoji: clean(input.emoji),
  notes: clean(input.notes),
  dueDate: isYMD(input.dueDate) ? input.dueDate : null,
  budget: input.budget && input.budget > 0 ? Math.round(input.budget * 100) / 100 : null,
  currency: input.currency ?? "ARS",
});

/** Normaliza un ítem nuevo o editado (sin el id, orden ni estado). */
export const itemBaseFields = (input: ListItemInput) => ({
  title: input.title.trim(),
  quantity: clean(input.quantity),
  notes: clean(input.notes),
  estimatedAmount:
    input.estimatedAmount && input.estimatedAmount > 0 ? Math.round(input.estimatedAmount * 100) / 100 : null,
});

/** id corto para un ítem (único dentro de su lista). */
export const newItemId = (): string => {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 16);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};

// === Acceso ===

const ROLE_RANK: Record<ListRole, number> = { view: 1, edit: 2, owner: 3 };

/**
 * Acceso efectivo de un nodo: el dueño, más lo compartido en cada nodo de la
 * cadena (de la raíz al nodo), quedándose con el permiso más alto de cada
 * persona. Una persona que todavía no tiene cuenta se identifica por email.
 */
export const effectiveAccess = (owner: ListPerson & { uid: string }, chain: ListShare[][]) => {
  const byEmail = new Map<string, ListMember>();
  const ownerEmail = owner.email.toLowerCase();
  byEmail.set(ownerEmail, {
    uid: owner.uid,
    email: ownerEmail,
    displayName: owner.displayName ?? null,
    photoURL: owner.photoURL ?? null,
    role: "owner",
  });
  for (const shares of chain) {
    for (const s of shares) {
      const email = s.email.trim().toLowerCase();
      if (!email) continue;
      const prev = byEmail.get(email);
      if (!prev) {
        byEmail.set(email, {
          uid: s.uid ?? null,
          email,
          displayName: s.displayName ?? null,
          photoURL: s.photoURL ?? null,
          role: s.role,
        });
      } else {
        byEmail.set(email, {
          ...prev,
          uid: prev.uid ?? s.uid ?? null,
          displayName: prev.displayName ?? s.displayName ?? null,
          photoURL: prev.photoURL ?? s.photoURL ?? null,
          role: ROLE_RANK[s.role] > ROLE_RANK[prev.role] ? s.role : prev.role,
        });
      }
    }
  }
  const members = [...byEmail.values()];
  return { members, ...accessIndexFields(members) };
};

/** Arrays para las consultas y las reglas (incluyen al dueño). */
export const accessIndexFields = (members: ListMember[]) => {
  const uniq = (xs: Array<string | null | undefined>) =>
    Array.from(new Set(xs.filter((x): x is string => !!x)));
  const editors = members.filter((m) => m.role !== "view");
  return {
    memberUids: uniq(members.map((m) => m.uid)),
    memberEmails: uniq(members.map((m) => m.email.toLowerCase())),
    editorUids: uniq(editors.map((m) => m.uid)),
    editorEmails: uniq(editors.map((m) => m.email.toLowerCase())),
  };
};

/** Mi permiso en un nodo (por uid o, si me invitaron antes de tener cuenta, por email). */
export const myRole = (
  node: Pick<ListNode, "ownerUid" | "members">,
  me: { uid: string; email?: string | null },
): ListRole | null => {
  if (node.ownerUid === me.uid) return "owner";
  const email = me.email?.toLowerCase();
  const m =
    node.members.find((x) => x.uid === me.uid) ??
    (email ? node.members.find((x) => x.email.toLowerCase() === email) : undefined);
  return m?.role ?? null;
};

export const canEdit = (role: ListRole | null) => role === "owner" || role === "edit";

export const personName = (p: { displayName?: string | null; email: string }) =>
  p.displayName?.trim() || p.email.split("@")[0];

export const roleLabel = (r: ListRole) =>
  r === "owner" ? "Dueño" : r === "edit" ? "Puede editar" : "Puede ver";

// === Árbol ===

export const compareNodes = (a: ListNode, b: ListNode) =>
  a.order - b.order || a.title.localeCompare(b.title);

/** Hijos de cada nodo (las raíces van en la clave ""). */
export const childrenIndex = (nodes: ListNode[]): Map<string, ListNode[]> => {
  const ids = new Set(nodes.map((n) => n.id));
  const map = new Map<string, ListNode[]>();
  for (const n of nodes) {
    // Si no veo al padre (me compartieron solo esta parte), para mí es raíz.
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : "";
    const arr = map.get(key);
    if (arr) arr.push(n);
    else map.set(key, [n]);
  }
  for (const arr of map.values()) arr.sort(compareNodes);
  return map;
};

export const rootsOf = (index: Map<string, ListNode[]>) => index.get("") ?? [];
export const childrenOf = (index: Map<string, ListNode[]>, id: string) => index.get(id) ?? [];

/** Todos los nodos de adentro (sin el propio). */
export const descendantsOf = (index: Map<string, ListNode[]>, id: string): ListNode[] => {
  const out: ListNode[] = [];
  const stack = [...childrenOf(index, id)];
  while (stack.length) {
    const n = stack.shift()!;
    out.push(n);
    stack.push(...childrenOf(index, n.id));
  }
  return out;
};

/** Ancestros visibles, de la raíz al padre. */
export const ancestorsOf = (byId: Map<string, ListNode>, node: ListNode): ListNode[] => {
  const out: ListNode[] = [];
  const seen = new Set<string>([node.id]);
  let cur = node.parentId ? byId.get(node.parentId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
};

/** "Mi cumple › Compras" */
export const nodePath = (byId: Map<string, ListNode>, node: ListNode) =>
  [...ancestorsOf(byId, node), node].map((n) => n.title).join(" › ");

// === Ítems ===

export const sortedItems = (node: Pick<ListNode, "items">): ListItem[] =>
  Object.values(node.items ?? {}).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

export const itemCounts = (node: Pick<ListNode, "items">) => {
  const items = Object.values(node.items ?? {});
  return { total: items.length, done: items.filter((i) => i.done).length };
};

// === Plata ===

export type MoneyByCurrency = Partial<Record<Currency, number>>;

const add = (m: MoneyByCurrency, c: Currency, v: number) => {
  m[c] = Math.round(((m[c] ?? 0) + v) * 100) / 100;
};

/** Lo gastado en un ítem (todas las personas), por moneda. */
export const itemSpent = (item: ListItem): MoneyByCurrency => {
  const m: MoneyByCurrency = {};
  for (const e of Object.values(item.expenses ?? {})) add(m, e.currency, e.amount);
  return m;
};

export const hasExpenses = (item: ListItem) => Object.keys(item.expenses ?? {}).length > 0;

/** Lo gastado en un nodo: si es grupo, la suma de todo lo de adentro. */
export const nodeSpent = (node: ListNode, index: Map<string, ListNode[]>): MoneyByCurrency => {
  const m: MoneyByCurrency = {};
  for (const n of [node, ...descendantsOf(index, node.id)]) {
    for (const item of Object.values(n.items ?? {})) {
      for (const [c, v] of Object.entries(itemSpent(item)) as Array<[Currency, number]>) add(m, c, v);
    }
  }
  return m;
};

/**
 * Lo previsto: lo gastado más lo estimado de los ítems que todavía no tienen
 * gasto (en la moneda de cada lista).
 */
export const nodeProjected = (node: ListNode, index: Map<string, ListNode[]>): MoneyByCurrency => {
  const m: MoneyByCurrency = {};
  for (const n of [node, ...descendantsOf(index, node.id)]) {
    for (const item of Object.values(n.items ?? {})) {
      if (hasExpenses(item)) {
        for (const [c, v] of Object.entries(itemSpent(item)) as Array<[Currency, number]>) add(m, c, v);
      } else if (item.estimatedAmount) {
        add(m, n.currency, item.estimatedAmount);
      }
    }
  }
  return m;
};

/**
 * Pasa montos en varias monedas a una sola. Lo que no se puede convertir (sin
 * cotización) queda afuera y se informa en `missing`.
 */
export const moneyIn = (
  m: MoneyByCurrency,
  target: Currency,
  rates: FxRatesMap | null | undefined,
): { total: number; missing: Currency[] } => {
  let total = m[target] ?? 0;
  const missing: Currency[] = [];
  const arsPerTarget = target === "ARS" ? 1 : rates?.[target];
  for (const [c, v] of Object.entries(m) as Array<[Currency, number]>) {
    if (c === target || !v) continue;
    const ars = c === "ARS" ? v : rates?.[c] ? v * rates[c]! : null;
    if (ars == null || !arsPerTarget) {
      missing.push(c);
      continue;
    }
    total += ars / arsPerTarget;
  }
  return { total: Math.round(total * 100) / 100, missing };
};

export interface BudgetStatus {
  spent: number;
  budget: number | null;
  /** 0–100 (tope a 100 para la barra). */
  pct: number;
  remaining: number | null;
  over: boolean;
}

export const budgetStatus = (spent: number, budget: number | null | undefined): BudgetStatus => {
  const b = budget && budget > 0 ? budget : null;
  if (!b) return { spent, budget: null, pct: 0, remaining: null, over: false };
  const remaining = Math.round((b - spent) * 100) / 100;
  return { spent, budget: b, pct: Math.min(100, Math.max(0, (spent / b) * 100)), remaining, over: remaining < 0 };
};

// === Fechas ===

export const todayYMD = () => ymdAR();

/** "Vence hoy", "Vence mañana", "Vence en 5 días", "Venció hace 2 días", "Vence el 24/12". */
export const dueLabel = (dueDate: string | null | undefined, today = ymdAR()): string | null => {
  if (!dueDate) return null;
  if (dueDate === today) return "Vence hoy";
  if (dueDate === addDaysYMD(today, 1)) return "Vence mañana";
  const days = Math.round(
    (new Date(`${dueDate}T12:00:00-03:00`).getTime() - new Date(`${today}T12:00:00-03:00`).getTime()) / 86_400_000,
  );
  if (days < 0) return days === -1 ? "Venció ayer" : `Venció hace ${-days} días`;
  if (days <= 14) return `Vence en ${days} días`;
  const [y, mo, d] = dueDate.split("-");
  return `Vence el ${d}/${mo}${y !== today.slice(0, 4) ? `/${y}` : ""}`;
};

export const isOverdue = (dueDate: string | null | undefined, today = ymdAR()) => !!dueDate && dueDate < today;

// === Búsqueda por nombre (para el agente) ===

export const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^(la|el|los|las|lista|grupo)\s+(de(l)?\s+)?/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Busca por nombre: primero exacto, después que empiece igual, después que lo contenga. */
export const matchByName = <T extends { title: string }>(xs: T[], query: string): T[] => {
  const q = normName(query);
  if (!q) return [];
  const exact = xs.filter((x) => normName(x.title) === q);
  if (exact.length) return exact;
  const starts = xs.filter((x) => normName(x.title).startsWith(q));
  if (starts.length) return starts;
  return xs.filter((x) => normName(x.title).includes(q) || q.includes(normName(x.title)));
};

// === Resumen de un nodo (tarjetas, encabezado y agente) ===

export interface NodeSummary {
  /** En la moneda del nodo. */
  spent: number;
  projected: number;
  missing: Currency[];
  status: BudgetStatus;
  /** Ítems de la lista o de todas las listas de adentro. */
  items: { done: number; total: number };
  /** Hijos directos. */
  lists: number;
  groups: number;
}

export const nodeSummary = (
  node: ListNode,
  index: Map<string, ListNode[]>,
  rates: FxRatesMap | null | undefined,
): NodeSummary => {
  const spent = moneyIn(nodeSpent(node, index), node.currency, rates);
  const projected = moneyIn(nodeProjected(node, index), node.currency, rates);
  const items = { done: 0, total: 0 };
  for (const n of [node, ...descendantsOf(index, node.id)]) {
    const c = itemCounts(n);
    items.done += c.done;
    items.total += c.total;
  }
  const kids = childrenOf(index, node.id);
  return {
    spent: spent.total,
    projected: projected.total,
    missing: Array.from(new Set([...spent.missing, ...projected.missing])),
    status: budgetStatus(spent.total, node.budget),
    items,
    lists: kids.filter((k) => k.kind === "list").length,
    groups: kids.filter((k) => k.kind === "group").length,
  };
};

/** "2 listas · 1 grupo" */
export const childrenLabel = (s: Pick<NodeSummary, "lists" | "groups">) =>
  [
    s.lists ? `${s.lists} ${s.lists === 1 ? "lista" : "listas"}` : "",
    s.groups ? `${s.groups} ${s.groups === 1 ? "grupo" : "grupos"}` : "",
  ]
    .filter(Boolean)
    .join(" · ") || "Vacío";
