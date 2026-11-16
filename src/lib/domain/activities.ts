import {
  Timestamp,
  addDoc,
  collection,
  deleteField,
  doc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";

import {
  activitiesCollectionPath,
  activityBaseFields as baseFields,
  activityIndexFields as indexFields,
  mergeParticipants,
  type Activity,
  type ActivityExpense,
  type ActivityInput,
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

/** Vincula (o desvincula) el gasto que cargó este usuario. Solo toca su propia entrada. */
export const setActivityExpense = async (
  activityId: string,
  uid: string,
  expense: Omit<ActivityExpense, "createdAt"> | null,
): Promise<void> => {
  await updateDoc(doc(db, `${activitiesCollectionPath()}/${activityId}`), {
    [`expenses.${uid}`]: expense ? { ...expense, createdAt: Timestamp.now() } : deleteField(),
    updatedAt: Timestamp.now(),
  });
};

