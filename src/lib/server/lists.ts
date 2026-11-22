import "server-only";

import { FieldValue, type DocumentSnapshot, type WriteBatch } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import { sendEmail } from "./resend";
import { renderListShareEmail } from "./mail-templates";
import { tryGetAppRates } from "./fx";
import { formatMoney } from "@/lib/format";
import {
  ancestorsOf,
  canEdit,
  childrenIndex,
  descendantsOf,
  effectiveAccess,
  itemBaseFields,
  listLinksCollectionPath,
  listsCollectionPath,
  myRole,
  newItemId,
  nodeBaseFields,
  nodeSummary,
  normName,
  personName,
  type ListItem,
  type ListItemExpense,
  type ListItemInput,
  type ListLink,
  type ListNode,
  type ListNodeInput,
  type ListNodeKind,
  type ListPerson,
  type ListRole,
  type ListShare,
} from "@/lib/domain/list-model";

/**
 * Listas desde el server (Admin SDK): compartir (recalcula el acceso de todo
 * el subárbol) y las operaciones que usa el agente de WhatsApp. El Admin SDK
 * saltea las reglas, así que acá se valida el permiso de cada operación.
 */

export class ListError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ListError";
    this.status = status;
  }
}

export interface ListActor {
  uid: string;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
}

const col = () => adminDb().collection(listsCollectionPath());

const toNode = (snap: DocumentSnapshot): ListNode => ({ id: snap.id, ...snap.data() }) as ListNode;

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** Datos del usuario (para firmar lo que hace y resolver su acceso por email). */
export const loadActor = async (uid: string): Promise<ListActor> => {
  const d = (await adminDb().collection("users").doc(uid).get()).data() ?? {};
  return {
    uid,
    email: ((d.email as string | undefined) ?? "").toLowerCase(),
    displayName: (d.displayName as string | undefined) ?? null,
    photoURL: (d.photoURL as string | undefined) ?? null,
  };
};

/** Todos los grupos y listas a los que tiene acceso (por uid o por email). */
export const listNodesFor = async (me: { uid: string; email?: string | null }): Promise<ListNode[]> => {
  const email = me.email?.toLowerCase();
  const [a, b] = await Promise.all([
    col().where("memberUids", "array-contains", me.uid).get(),
    email ? col().where("memberEmails", "array-contains", email).get() : Promise.resolve(null),
  ]);
  const map = new Map<string, ListNode>();
  for (const d of [...a.docs, ...(b?.docs ?? [])]) map.set(d.id, toNode(d));
  return [...map.values()];
};

/** Un nodo y mi permiso; error si no existe o no lo puedo ver. */
export const getNodeFor = async (
  me: { uid: string; email?: string | null },
  id: string,
): Promise<{ node: ListNode; role: ListRole }> => {
  const snap = await col().doc(id).get();
  if (!snap.exists) throw new ListError("Esa lista ya no existe", 404);
  const node = toNode(snap);
  const role = myRole(node, me);
  if (!role) throw new ListError("No tenés acceso a esa lista", 403);
  return { node, role };
};

const assertEdit = (role: ListRole, node: ListNode) => {
  if (!canEdit(role)) {
    throw new ListError(`"${node.title}" te la compartieron solo para ver: no la podés cambiar`, 403);
  }
};

/** Hijos directos (sin importar quién los ve). */
const childrenAdmin = async (id: string): Promise<ListNode[]> =>
  (await col().where("parentId", "==", id).get()).docs.map(toNode);

/** Todo lo de adentro de un nodo (BFS). */
const subtreeAdmin = async (root: ListNode): Promise<ListNode[]> => {
  const out: ListNode[] = [root];
  const queue = [root.id];
  while (queue.length) {
    const kids = await childrenAdmin(queue.shift()!);
    for (const k of kids) {
      if (out.some((n) => n.id === k.id)) continue;
      out.push(k);
      queue.push(k.id);
    }
  }
  return out;
};

/** Ancestros (de la raíz al padre). */
const ancestorsAdmin = async (node: ListNode): Promise<ListNode[]> => {
  const out: ListNode[] = [];
  const seen = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const snap = await col().doc(parentId).get();
    if (!snap.exists) break;
    const p = toNode(snap);
    out.unshift(p);
    parentId = p.parentId;
  }
  return out;
};

const commitInChunks = async (ops: Array<(b: WriteBatch) => void>) => {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = adminDb().batch();
    for (const op of ops.slice(i, i + 400)) op(batch);
    await batch.commit();
  }
};

/**
 * Recalcula el acceso efectivo de un nodo y de todo lo de adentro, a partir de
 * lo compartido en sus ancestros y en cada nodo. `override` reemplaza los
 * shares de algunos nodos (lo que se está guardando).
 */
const recomputeAccess = async (top: ListNode, override: Map<string, ListShare[]> = new Map()) => {
  const ancestors = await ancestorsAdmin(top);
  const root = ancestors[0] ?? top;
  const owner: ListPerson & { uid: string } = {
    uid: root.ownerUid,
    email: root.ownerEmail,
    displayName: root.ownerDisplayName ?? null,
  };
  const baseChain = ancestors.map((a) => override.get(a.id) ?? a.shares ?? []);
  const subtree = await subtreeAdmin(top);
  const byId = new Map(subtree.map((n) => [n.id, n]));
  const chainOf = new Map<string, ListShare[][]>();
  const ops: Array<(b: WriteBatch) => void> = [];
  // subtree está en orden BFS: el padre siempre se procesa antes que el hijo.
  for (const n of subtree) {
    const parentChain = n.id === top.id ? baseChain : (chainOf.get(n.parentId ?? "") ?? baseChain);
    const shares = override.get(n.id) ?? n.shares ?? [];
    const chain = [...parentChain, shares];
    chainOf.set(n.id, chain);
    const access = effectiveAccess(owner, chain);
    const ref = col().doc(n.id);
    ops.push((b) =>
      b.update(ref, {
        ...(override.has(n.id) ? { shares } : {}),
        ownerUid: owner.uid,
        ownerEmail: owner.email,
        ownerDisplayName: owner.displayName ?? null,
        ...access,
        updatedAt: FieldValue.serverTimestamp(),
      }),
    );
  }
  await commitInChunks(ops);
  return { byId };
};

/** Completa el uid de los que ya tienen cuenta (los buscaba por email). */
const resolveShareUids = async (shares: ListShare[]): Promise<ListShare[]> =>
  Promise.all(
    shares.map(async (s) => {
      if (s.uid) return s;
      const found = await adminDb().collection("users").where("email", "==", s.email.toLowerCase()).limit(1).get();
      if (found.empty) return s;
      const d = found.docs[0].data();
      return {
        ...s,
        uid: found.docs[0].id,
        displayName: s.displayName ?? (d.displayName as string | undefined) ?? null,
        photoURL: s.photoURL ?? (d.photoURL as string | undefined) ?? null,
      };
    }),
  );

/**
 * Guarda con quién está compartido un nodo (reemplaza la lista entera) y
 * recalcula el acceso de todo lo de adentro. Solo el dueño puede compartir.
 * A los que se suman les llega un aviso (o un mail si no tienen cuenta).
 */
export const shareListNode = async (
  me: ListActor,
  nodeId: string,
  sharesIn: Array<Omit<ListShare, "email"> & { email: string }>,
): Promise<{ added: number; notified: number; emailed: number }> => {
  const { node } = await getNodeFor(me, nodeId);
  if (node.ownerUid !== me.uid) throw new ListError("Solo quien la creó puede compartirla", 403);

  const ownerEmail = node.ownerEmail.toLowerCase();
  const seen = new Set<string>([ownerEmail]);
  const cleaned: ListShare[] = [];
  for (const s of sharesIn) {
    const email = s.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    cleaned.push({
      uid: s.uid && s.uid !== me.uid ? s.uid : null,
      email,
      displayName: s.displayName ?? null,
      photoURL: s.photoURL ?? null,
      role: s.role === "edit" ? "edit" : "view",
    });
  }
  const shares = await resolveShareUids(cleaned);
  const before = new Set(node.members.map((m) => m.email.toLowerCase()));
  await recomputeAccess(node, new Map([[node.id, shares]]));

  // Avisar a los nuevos.
  const from = personName({ displayName: me.displayName ?? node.ownerDisplayName, email: me.email || ownerEmail });
  const what = node.kind === "group" ? "el grupo" : "la lista";
  let notified = 0;
  let emailed = 0;
  const added = shares.filter((s) => !before.has(s.email));
  for (const s of added) {
    const can = s.role === "edit" ? "podés ver y editar" : "podés verla";
    if (s.uid) {
      const r = await notify(s.uid, {
        kind: "list-shared",
        title: `${from} te compartió ${what} ${node.title}`,
        body: s.role === "edit" ? "Podés verla, tildar cosas y cargar lo que gastes." : "Podés verla en Listas.",
        url: `/listas/${node.id}`,
        whatsappText: `📝 *${from}* te compartió ${what} *${node.title}* (${can}). La tenés en Listas de la app, o pedímela por acá.`,
        dedupeKey: `list-shared-${node.id}-${s.uid}`,
      });
      if (r.stored) notified += 1;
    } else {
      const { subject, html, text } = renderListShareEmail({
        ownerName: from,
        ownerEmail,
        title: node.title,
        kind: node.kind,
        role: s.role,
        appUrl: appUrl(),
      });
      const r = await sendEmail({ to: s.email, subject, html, text });
      if (r.ok) emailed += 1;
    }
  }
  return { added: added.length, notified, emailed };
};

/** Me bajo de una lista que me compartieron (y de todo lo de adentro). */
export const leaveListNode = async (me: ListActor, nodeId: string): Promise<void> => {
  const { node } = await getNodeFor(me, nodeId);
  if (node.ownerUid === me.uid) throw new ListError("Sos el dueño: si no la querés más, borrala", 400);
  const email = me.email.toLowerCase();
  const isMe = (s: ListShare) => s.uid === me.uid || (!!email && s.email.toLowerCase() === email);
  const ancestors = await ancestorsAdmin(node);
  const subtree = await subtreeAdmin(node);
  const override = new Map<string, ListShare[]>();
  let top: ListNode | null = null;
  for (const n of [...ancestors, ...subtree]) {
    if ((n.shares ?? []).some(isMe)) {
      override.set(n.id, (n.shares ?? []).filter((s) => !isMe(s)));
      top ??= n;
    }
  }
  if (!top) throw new ListError("No encontré dónde te la compartieron", 400);
  await recomputeAccess(top, override);
};

// === Operaciones (para el agente) ===

/** Crea un grupo o lista (adentro de otro nodo, hereda su acceso). */
export const createNodeAdmin = async (
  me: ListActor,
  parentId: string | null,
  kind: ListNodeKind,
  input: ListNodeInput,
  items: ListItemInput[] = [],
): Promise<ListNode> => {
  let parent: ListNode | null = null;
  if (parentId) {
    const r = await getNodeFor(me, parentId);
    assertEdit(r.role, r.node);
    if (r.node.kind !== "group") throw new ListError(`"${r.node.title}" es una lista, no un grupo: no puede tener listas adentro`);
    parent = r.node;
  }
  const access = parent
    ? {
        ownerUid: parent.ownerUid,
        ownerEmail: parent.ownerEmail,
        ownerDisplayName: parent.ownerDisplayName ?? null,
        members: parent.members,
        memberUids: parent.memberUids,
        memberEmails: parent.memberEmails,
        editorUids: parent.editorUids,
        editorEmails: parent.editorEmails,
      }
    : {
        ownerUid: me.uid,
        ownerEmail: me.email,
        ownerDisplayName: me.displayName ?? null,
        ...effectiveAccess(me, []),
      };
  const now = Date.now();
  const itemMap: Record<string, ListItem> = {};
  if (kind === "list") {
    items.forEach((it, i) => {
      const id = newItemId();
      itemMap[id] = {
        id,
        ...itemBaseFields(it),
        done: false,
        doneBy: null,
        doneByName: null,
        doneAt: null,
        order: now + i,
        createdBy: me.uid,
        createdAt: now + i,
        expenses: {},
      };
    });
  }
  const ref = col().doc();
  const data = {
    kind,
    parentId: parent?.id ?? null,
    createdBy: me.uid,
    ...nodeBaseFields(input),
    order: now,
    shares: [],
    ...access,
    ...(kind === "list" ? { items: itemMap } : {}),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(data);
  return { id: ref.id, ...data } as unknown as ListNode;
};

/** Cambia título, fecha o tope (solo lo que viene). `null` borra el campo. */
export const updateNodeAdmin = async (
  me: ListActor,
  id: string,
  patch: Partial<ListNodeInput>,
): Promise<ListNode> => {
  const { node, role } = await getNodeFor(me, id);
  assertEdit(role, node);
  const merged = nodeBaseFields({
    title: patch.title ?? node.title,
    emoji: patch.emoji !== undefined ? patch.emoji : node.emoji,
    notes: patch.notes !== undefined ? patch.notes : node.notes,
    dueDate: patch.dueDate !== undefined ? patch.dueDate : node.dueDate,
    budget: patch.budget !== undefined ? patch.budget : node.budget,
    currency: patch.currency ?? node.currency,
  });
  await col().doc(id).update({ ...merged, updatedAt: FieldValue.serverTimestamp() });
  return { ...node, ...merged };
};

/** Agrega ítems. Los que ya están (sin tildar, mismo nombre) no se repiten. */
export const addItemsAdmin = async (
  me: ListActor,
  listId: string,
  items: ListItemInput[],
): Promise<{ node: ListNode; added: string[]; already: string[] }> => {
  const { node, role } = await getNodeFor(me, listId);
  assertEdit(role, node);
  if (node.kind !== "list") throw new ListError(`"${node.title}" es un grupo: los ítems van en una lista de adentro`);
  const existing = Object.values(node.items ?? {});
  const now = Date.now();
  const update: Record<string, unknown> = {};
  const added: string[] = [];
  const already: string[] = [];
  items.forEach((it, i) => {
    const base = itemBaseFields(it);
    if (!base.title) return;
    const dup = existing.find((x) => !x.done && normName(x.title) === normName(base.title));
    if (dup) {
      already.push(dup.title);
      return;
    }
    const id = newItemId();
    const item: ListItem = {
      id,
      ...base,
      done: false,
      doneBy: null,
      doneByName: null,
      doneAt: null,
      order: now + i,
      createdBy: me.uid,
      createdAt: now + i,
      expenses: {},
    };
    update[`items.${id}`] = item;
    existing.push(item);
    added.push(base.title);
  });
  if (added.length) await col().doc(listId).update({ ...update, updatedAt: FieldValue.serverTimestamp() });
  return { node, added, already };
};

/** Tilda o destilda ítems. */
export const setItemsDoneAdmin = async (
  me: ListActor,
  listId: string,
  itemIds: string[],
  done: boolean,
): Promise<void> => {
  const { node, role } = await getNodeFor(me, listId);
  assertEdit(role, node);
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  const now = Date.now();
  for (const id of itemIds) {
    if (!node.items?.[id]) continue;
    update[`items.${id}.done`] = done;
    update[`items.${id}.doneBy`] = done ? me.uid : null;
    update[`items.${id}.doneByName`] = done ? (me.displayName ?? null) : null;
    update[`items.${id}.doneAt`] = done ? now : null;
  }
  await col().doc(listId).update(update);
};

export const removeItemsAdmin = async (me: ListActor, listId: string, itemIds: string[]): Promise<void> => {
  const { node, role } = await getNodeFor(me, listId);
  assertEdit(role, node);
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const id of itemIds) if (node.items?.[id]) update[`items.${id}`] = FieldValue.delete();
  await col().doc(listId).update(update);
};

/** Borra un nodo con todo lo de adentro. Devuelve cuántos nodos borró. */
export const deleteNodeAdmin = async (me: ListActor, id: string): Promise<number> => {
  const { node, role } = await getNodeFor(me, id);
  assertEdit(role, node);
  const all = await subtreeAdmin(node);
  await commitInChunks(all.map((n) => (b) => b.delete(col().doc(n.id))));
  return all.length;
};

/** Vincula el gasto que cargó el usuario a un ítem (y lo tilda). */
export const setItemExpenseAdmin = async (
  me: ListActor,
  listId: string,
  itemId: string,
  expense: Omit<ListItemExpense, "createdAt">,
  /** Libreta donde está el movimiento (si no es la mía: cuenta compartida). */
  txOwnerUid?: string,
): Promise<ListNode> => {
  const { node, role } = await getNodeFor(me, listId);
  assertEdit(role, node);
  if (!node.items?.[itemId]) throw new ListError("Ese ítem ya no está en la lista", 404);
  const now = Date.now();
  await col()
    .doc(listId)
    .update({
      [`items.${itemId}.expenses.${me.uid}`]: { ...expense, createdAt: now },
      [`items.${itemId}.done`]: true,
      [`items.${itemId}.doneBy`]: me.uid,
      [`items.${itemId}.doneByName`]: me.displayName ?? null,
      [`items.${itemId}.doneAt`]: now,
      updatedAt: FieldValue.serverTimestamp(),
    });
  // Índice inverso en la libreta donde quedó el movimiento (la del dueño de
  // la cuenta si se cargó en una cuenta compartida).
  const link: ListLink = { listId, itemId, byUid: me.uid, createdAt: now };
  await adminDb()
    .doc(`${listLinksCollectionPath(txOwnerUid ?? me.uid)}/${expense.transactionId}`)
    .set(link)
    .catch((err) => console.warn("[lists] no se pudo guardar el índice del gasto", err));
  const items = { ...node.items };
  items[itemId] = {
    ...items[itemId],
    done: true,
    expenses: { ...(items[itemId].expenses ?? {}), [me.uid]: { ...expense, createdAt: now } },
  };
  return { ...node, items };
};

/**
 * Se borró un movimiento desde el server (ej. al cancelar un reparto con
 * "borrar el gasto"): si era el gasto de un ítem, sale de la lista.
 */
export const unlinkTransactionAdmin = async (txOwnerUid: string, transactionId: string): Promise<void> => {
  try {
    const linkRef = adminDb().doc(`${listLinksCollectionPath(txOwnerUid)}/${transactionId}`);
    const linkSnap = await linkRef.get();
    if (!linkSnap.exists) return;
    const link = linkSnap.data() as ListLink;
    const listSnap = await col().doc(link.listId).get();
    const current = listSnap.exists
      ? (listSnap.data() as Omit<ListNode, "id">).items?.[link.itemId]?.expenses?.[link.byUid]
      : undefined;
    if (current?.transactionId === transactionId) {
      await col()
        .doc(link.listId)
        .update({
          [`items.${link.itemId}.expenses.${link.byUid}`]: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
    }
    await linkRef.delete();
  } catch (err) {
    console.warn("[lists] no se pudo sacar el gasto de la lista", err);
  }
};

/** Árbol del usuario (índice de hijos + mapa por id). */
export const loadTreeFor = async (me: { uid: string; email?: string | null }) => {
  const nodes = await listNodesFor(me);
  const index = childrenIndex(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { nodes, index, byId, descendants: (id: string) => descendantsOf(index, id) };
};

/**
 * Para el bot: vincula un gasto recién guardado al ítem de una lista (si el
 * ítem no existe, lo agrega) y devuelve una línea para la respuesta con cómo
 * viene el gasto contra el tope.
 */
export const linkTransactionToListItem = async (
  uid: string,
  link: { listId: string; itemId: string | null; listTitle: string; itemTitle: string },
  expense: Omit<ListItemExpense, "createdAt" | "byName">,
  /** Libreta donde quedó el movimiento (la del dueño, si fue en una cuenta compartida). */
  txOwnerUid?: string,
): Promise<string> => {
  const me = await loadActor(uid);
  const { node, role } = await getNodeFor(me, link.listId);
  assertEdit(role, node);
  let itemId = link.itemId && node.items?.[link.itemId] ? link.itemId : null;
  if (!itemId) {
    const existing = Object.values(node.items ?? {}).find((i) => normName(i.title) === normName(link.itemTitle));
    if (existing) itemId = existing.id;
    else {
      const id = newItemId();
      const now = Date.now();
      const item: ListItem = {
        id,
        ...itemBaseFields({ title: link.itemTitle }),
        done: false,
        doneBy: null,
        doneByName: null,
        doneAt: null,
        order: now,
        createdBy: uid,
        createdAt: now,
        expenses: {},
      };
      await col().doc(node.id).update({ [`items.${id}`]: item, updatedAt: FieldValue.serverTimestamp() });
      node.items = { ...(node.items ?? {}), [id]: item };
      itemId = id;
    }
  }
  await setItemExpenseAdmin(me, node.id, itemId, { ...expense, byName: me.displayName ?? null }, txOwnerUid);

  // Cómo viene: la lista y, si tiene, el grupo más cercano con tope.
  const [tree, fx] = await Promise.all([loadTreeFor(me), tryGetAppRates()]);
  const fresh = tree.byId.get(node.id);
  const itemTitle = fresh?.items?.[itemId]?.title ?? link.itemTitle;
  let text = `\n📝 Lo vinculé a *${itemTitle}* (${link.listTitle}).`;
  if (fresh) {
    const withBudget = [fresh, ...ancestorsOf(tree.byId, fresh).reverse()].find((n) => n.budget);
    const target = withBudget ?? fresh;
    const s = nodeSummary(target, tree.index, fx?.rates ?? null);
    const where = target.id === fresh.id ? "En la lista" : `En *${target.title}*`;
    if (target.budget) {
      text += ` ${where} llevás ${formatMoney(s.spent, target.currency)} de ${formatMoney(target.budget, target.currency)}`;
      text += s.status.over
        ? ` ⚠️ te pasaste ${formatMoney(-(s.status.remaining ?? 0), target.currency)}.`
        : ` (quedan ${formatMoney(s.status.remaining ?? 0, target.currency)}).`;
    } else if (s.spent > 0) {
      text += ` ${where} van ${formatMoney(s.spent, target.currency)}.`;
    }
  }
  return text;
};
