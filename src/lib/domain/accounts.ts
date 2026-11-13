import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Account } from "./types";

export const accountsCollectionPath = (uid: string): string =>
  `users/${uid}/accounts`;

const EDITABLE_FIELDS: Array<keyof Account> = [
  "name",
  "type",
  "icon",
  "parentId",
  "active",
  "defaultClosingDay",
  "defaultDueDay",
  "currencies",
  "isMain",
  "openingBalances",
  "openingDate",
];

export const updateAccount = async (
  uid: string,
  id: string,
  patch: Partial<Account>,
): Promise<void> => {
  const data: Record<string, unknown> = {};
  for (const k of EDITABLE_FIELDS) {
    if (k in patch) data[k] = patch[k] ?? null;
  }
  await updateDoc(doc(db, `${accountsCollectionPath(uid)}/${id}`), data);
};

export const setAccountActive = async (
  uid: string,
  id: string,
  active: boolean,
): Promise<void> => {
  await updateDoc(doc(db, `${accountsCollectionPath(uid)}/${id}`), { active });
};

export const deleteAccount = async (
  uid: string,
  id: string,
): Promise<void> => {
  // Si es padre de tarjetas, desasociarlas (parentId -> null) antes de borrar.
  const childrenSnap = await getDocs(
    query(
      collection(db, accountsCollectionPath(uid)),
      where("parentId", "==", id),
    ),
  );
  if (!childrenSnap.empty) {
    const batch = writeBatch(db);
    childrenSnap.forEach((d) => batch.update(d.ref, { parentId: null }));
    await batch.commit();
  }
  await deleteDoc(doc(db, `${accountsCollectionPath(uid)}/${id}`));
};

/** Desmarca como principal a todas las cuentas menos `keepId`. */
export const clearOtherMainAccounts = async (uid: string, keepId: string | null): Promise<void> => {
  const snap = await getDocs(
    query(collection(db, accountsCollectionPath(uid)), where("isMain", "==", true)),
  );
  const others = snap.docs.filter((d) => d.id !== keepId);
  if (others.length === 0) return;
  const batch = writeBatch(db);
  others.forEach((d) => batch.update(d.ref, { isMain: false }));
  await batch.commit();
};

/**
 * Orden para mostrar cuentas: el que eligió el usuario (sortOrder) y, para las
 * que no tienen, el de creación.
 */
export const sortAccounts = <T extends Pick<Account, "sortOrder" | "createdAt">>(list: T[]): T[] =>
  [...list].sort((a, b) => {
    const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0);
  });

/** Guarda el orden de una lista de cuentas (la posición pasa a ser su sortOrder). */
export const saveAccountOrder = async (uid: string, orderedIds: string[]): Promise<void> => {
  const batch = writeBatch(db);
  orderedIds.forEach((id, index) => {
    batch.update(doc(db, `${accountsCollectionPath(uid)}/${id}`), { sortOrder: index });
  });
  await batch.commit();
};
