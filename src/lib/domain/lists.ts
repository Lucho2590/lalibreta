import {
  Timestamp,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";

import {
  descendantsOf,
  effectiveAccess,
  itemBaseFields,
  listLinksCollectionPath,
  listsCollectionPath,
  newItemId,
  nodeBaseFields,
  type ListItem,
  type ListItemExpense,
  type ListItemInput,
  type ListLink,
  type ListNode,
  type ListNodeInput,
  type ListNodeKind,
  type ListPerson,
} from "./list-model";

export * from "./list-model";

const nodeRef = (id: string) => doc(db, `${listsCollectionPath()}/${id}`);

/**
 * Crea un grupo o una lista. Adentro de otro nodo hereda el dueño y el acceso
 * del padre (las reglas lo verifican); en la raíz, el dueño soy yo.
 */
export const createNode = async (
  me: ListPerson & { uid: string },
  parent: ListNode | null,
  kind: ListNodeKind,
  input: ListNodeInput,
): Promise<string> => {
  const ref = doc(collection(db, listsCollectionPath()));
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
        ownerEmail: me.email.toLowerCase(),
        ownerDisplayName: me.displayName ?? null,
        ...effectiveAccess(me, []),
      };
  const data: Omit<ListNode, "id"> = {
    kind,
    parentId: parent?.id ?? null,
    createdBy: me.uid,
    ...nodeBaseFields(input),
    order: Date.now(),
    shares: [],
    ...access,
    ...(kind === "list" ? { items: {} } : {}),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  await setDoc(ref, data);
  return ref.id;
};

export const updateNode = async (id: string, input: ListNodeInput): Promise<void> => {
  await updateDoc(nodeRef(id), { ...nodeBaseFields(input), updatedAt: Timestamp.now() });
};

/** Borra el nodo y todo lo de adentro (los gastos vinculados siguen en los movimientos). */
export const deleteNodeTree = async (node: ListNode, index: Map<string, ListNode[]>): Promise<void> => {
  const all = [node, ...descendantsOf(index, node.id)];
  for (let i = 0; i < all.length; i += 400) {
    const batch = writeBatch(db);
    for (const n of all.slice(i, i + 400)) batch.delete(nodeRef(n.id));
    await batch.commit();
  }
};

// === Ítems ===

export const addItem = async (listId: string, uid: string, input: ListItemInput): Promise<string> => {
  const id = newItemId();
  const now = Date.now();
  const item: ListItem = {
    id,
    ...itemBaseFields(input),
    done: false,
    doneBy: null,
    doneByName: null,
    doneAt: null,
    order: now,
    createdBy: uid,
    createdAt: now,
    expenses: {},
  };
  await updateDoc(nodeRef(listId), { [`items.${id}`]: item, updatedAt: Timestamp.now() });
  return id;
};

export const updateItem = async (listId: string, itemId: string, input: ListItemInput): Promise<void> => {
  const fields = itemBaseFields(input);
  await updateDoc(nodeRef(listId), {
    [`items.${itemId}.title`]: fields.title,
    [`items.${itemId}.quantity`]: fields.quantity,
    [`items.${itemId}.notes`]: fields.notes,
    [`items.${itemId}.estimatedAmount`]: fields.estimatedAmount,
    updatedAt: Timestamp.now(),
  });
};

export const toggleItem = async (
  listId: string,
  itemId: string,
  done: boolean,
  by: { uid: string; name?: string | null },
): Promise<void> => {
  await updateDoc(nodeRef(listId), {
    [`items.${itemId}.done`]: done,
    [`items.${itemId}.doneBy`]: done ? by.uid : null,
    [`items.${itemId}.doneByName`]: done ? (by.name ?? null) : null,
    [`items.${itemId}.doneAt`]: done ? Date.now() : null,
    updatedAt: Timestamp.now(),
  });
};

export const deleteItem = async (listId: string, itemId: string): Promise<void> => {
  await updateDoc(nodeRef(listId), { [`items.${itemId}`]: deleteField(), updatedAt: Timestamp.now() });
};

/**
 * Vincula (o desvincula) el gasto que cargó este usuario para un ítem. Al
 * vincular, el ítem queda tildado. También guarda (o borra) el índice inverso
 * en mi libreta para que la lista se actualice si edito o borro el gasto.
 */
export const setItemExpense = async (
  listId: string,
  itemId: string,
  me: { uid: string; name?: string | null },
  expense: Omit<ListItemExpense, "createdAt"> | null,
  /** Al desvincular: el gasto que estaba (para borrar el índice). */
  previousTransactionId?: string | null,
): Promise<void> => {
  await updateDoc(nodeRef(listId), {
    [`items.${itemId}.expenses.${me.uid}`]: expense ? { ...expense, createdAt: Date.now() } : deleteField(),
    ...(expense
      ? {
          [`items.${itemId}.done`]: true,
          [`items.${itemId}.doneBy`]: me.uid,
          [`items.${itemId}.doneByName`]: me.name ?? null,
          [`items.${itemId}.doneAt`]: Date.now(),
        }
      : {}),
    updatedAt: Timestamp.now(),
  });
  try {
    if (expense) {
      const link: ListLink = { listId, itemId, byUid: me.uid, createdAt: Date.now() };
      await setDoc(doc(db, `${listLinksCollectionPath(me.uid)}/${expense.transactionId}`), link);
    } else if (previousTransactionId) {
      await deleteDoc(doc(db, `${listLinksCollectionPath(me.uid)}/${previousTransactionId}`));
    }
  } catch (err) {
    console.warn("[listas] no se pudo guardar el índice del gasto", err);
  }
};

/**
 * Un movimiento mío se editó o se borró: si estaba vinculado a un ítem de una
 * lista, se actualiza (o se saca) el gasto del ítem. Nunca tira error: si ya no
 * tengo acceso a la lista o el ítem no está, se ignora.
 */
export const syncListLinkForTransaction = async (
  uid: string,
  transactionId: string,
  change: { deleted: true } | { deleted?: false; amount: number; currency: ListItemExpense["currency"] },
): Promise<void> => {
  try {
    const linkRef = doc(db, `${listLinksCollectionPath(uid)}/${transactionId}`);
    const linkSnap = await getDoc(linkRef);
    if (!linkSnap.exists()) return;
    const link = linkSnap.data() as ListLink;
    const listSnap = await getDoc(nodeRef(link.listId)).catch(() => null);
    const current = listSnap?.exists()
      ? (listSnap.data() as Omit<ListNode, "id">).items?.[link.itemId]?.expenses?.[link.byUid]
      : undefined;
    // Solo si el ítem sigue apuntando a ESTE gasto (pudo desvincularse o reemplazarse).
    if (current?.transactionId === transactionId) {
      const path = `items.${link.itemId}.expenses.${link.byUid}`;
      await updateDoc(
        nodeRef(link.listId),
        change.deleted
          ? { [path]: deleteField(), updatedAt: Timestamp.now() }
          : { [`${path}.amount`]: change.amount, [`${path}.currency`]: change.currency, updatedAt: Timestamp.now() },
      );
    }
    if (change.deleted || current?.transactionId !== transactionId) await deleteDoc(linkRef);
  } catch (err) {
    console.warn("[listas] no se pudo actualizar la lista del gasto", err);
  }
};
