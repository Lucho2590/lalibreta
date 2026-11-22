import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";

import {
  activitiesCollectionPath,
  activityLinksCollectionPath,
  activityBaseFields as baseFields,
  activityIndexFields as indexFields,
  mergeParticipants,
  type Activity,
  type ActivityExpense,
  type ActivityInput,
  type ActivityLink,
  type Invitee,
} from "./activity-model";

export * from "./activity-model";

export const createActivity = async (
  owner: Invitee & { uid: string },
  input: ActivityInput,
  invitees: Invitee[],
): Promise<{ id: string; added: string[] }> => {
  const { participants, added } = mergeParticipants(owner, [], invitees);
  const data: Omit<Activity, "id"> = {
    ownerUid: owner.uid,
    ownerEmail: owner.email.toLowerCase(),
    ownerDisplayName: owner.displayName ?? null,
    ...baseFields(input),
    participants,
    ...indexFields(participants),
    expenses: {},
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  const ref = await addDoc(collection(db, activitiesCollectionPath()), data);
  return { id: ref.id, added };
};

/**
 * Vincula (o desvincula) el gasto que cargó este usuario. Solo toca su propia
 * entrada. También guarda (o borra) el índice inverso en su libreta para que
 * la actividad se actualice si edita o borra el gasto.
 */
export const setActivityExpense = async (
  activityId: string,
  uid: string,
  expense: Omit<ActivityExpense, "createdAt"> | null,
  /** Al desvincular: el gasto que estaba (para borrar el índice). */
  previousTransactionId?: string | null,
): Promise<void> => {
  await updateDoc(doc(db, `${activitiesCollectionPath()}/${activityId}`), {
    [`expenses.${uid}`]: expense ? { ...expense, createdAt: Timestamp.now() } : deleteField(),
    updatedAt: Timestamp.now(),
  });
  try {
    if (expense) {
      const link: ActivityLink = { activityId, createdAt: Date.now() };
      await setDoc(doc(db, `${activityLinksCollectionPath(uid)}/${expense.transactionId}`), link);
    } else if (previousTransactionId) {
      await deleteDoc(doc(db, `${activityLinksCollectionPath(uid)}/${previousTransactionId}`));
    }
  } catch (err) {
    console.warn("[agenda] no se pudo guardar el índice del gasto", err);
  }
};

/**
 * Un movimiento mío se editó o se borró: si era el gasto de una actividad, se
 * actualiza (o se saca) de la actividad. Nunca tira error.
 */
export const syncActivityLinkForTransaction = async (
  uid: string,
  transactionId: string,
  change: { deleted: true } | { deleted?: false; amount: number; currency: ActivityExpense["currency"] },
): Promise<void> => {
  try {
    const linkRef = doc(db, `${activityLinksCollectionPath(uid)}/${transactionId}`);
    const linkSnap = await getDoc(linkRef);
    if (!linkSnap.exists()) return;
    const { activityId } = linkSnap.data() as ActivityLink;
    const ref = doc(db, `${activitiesCollectionPath()}/${activityId}`);
    const snap = await getDoc(ref).catch(() => null);
    const current = snap?.exists() ? (snap.data() as Omit<Activity, "id">).expenses?.[uid] : undefined;
    // Solo si la actividad sigue apuntando a ESTE gasto.
    if (current?.transactionId === transactionId) {
      await updateDoc(
        ref,
        change.deleted
          ? { [`expenses.${uid}`]: deleteField(), updatedAt: Timestamp.now() }
          : {
              [`expenses.${uid}.amount`]: change.amount,
              [`expenses.${uid}.currency`]: change.currency,
              updatedAt: Timestamp.now(),
            },
      );
    }
    if (change.deleted || current?.transactionId !== transactionId) await deleteDoc(linkRef);
  } catch (err) {
    console.warn("[agenda] no se pudo actualizar la actividad del gasto", err);
  }
};
