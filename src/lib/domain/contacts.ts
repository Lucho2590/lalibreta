import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";

export const contactsCollectionPath = (uid: string): string =>
  `users/${uid}/contacts`;

const CONTACT_ID_REPLACE = /[^a-z0-9._-]/g;

// Email como id del doc — lo normalizamos para evitar caracteres ilegales.
export const contactIdFromEmail = (email: string): string =>
  email.trim().toLowerCase().replace(CONTACT_ID_REPLACE, "_");

export interface UpsertContactInput {
  email: string;
  displayName?: string | null;
  linkedUid?: string | null;
  photoURL?: string | null;
}

export const upsertContact = async (
  uid: string,
  input: UpsertContactInput,
): Promise<string> => {
  const email = input.email.trim().toLowerCase();
  const id = contactIdFromEmail(email);
  const ref = doc(db, `${contactsCollectionPath(uid)}/${id}`);
  await setDoc(
    ref,
    {
      email,
      displayName: input.displayName ?? null,
      linkedUid: input.linkedUid ?? null,
      photoURL: input.photoURL ?? null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  );
  return id;
};

export const updateContactLink = async (
  uid: string,
  contactId: string,
  link: { linkedUid: string | null; displayName?: string | null; photoURL?: string | null },
): Promise<void> => {
  await updateDoc(doc(db, `${contactsCollectionPath(uid)}/${contactId}`), {
    linkedUid: link.linkedUid,
    ...(link.displayName !== undefined ? { displayName: link.displayName } : {}),
    ...(link.photoURL !== undefined ? { photoURL: link.photoURL } : {}),
    updatedAt: Timestamp.now(),
  });
};

export const deleteContact = async (
  uid: string,
  contactId: string,
): Promise<void> => {
  await deleteDoc(doc(db, `${contactsCollectionPath(uid)}/${contactId}`));
};

/**
 * Contacto de alguien que no usa la app (para repartirle gastos o anotar
 * préstamos y que la app me recuerde cobrarle). El nombre es obligatorio.
 */
export const addOfflineContact = async (
  uid: string,
  input: { name: string; email?: string | null; phone?: string | null },
): Promise<string> => {
  const email = input.email?.trim().toLowerCase() || null;
  const data = {
    displayName: input.name.trim(),
    email,
    phone: input.phone?.trim() || null,
    linkedUid: null,
    kind: "offline" as const,
    photoURL: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  if (email) {
    const id = contactIdFromEmail(email);
    await setDoc(doc(db, `${contactsCollectionPath(uid)}/${id}`), data, { merge: true });
    return id;
  }
  const ref = await addDoc(collection(db, contactsCollectionPath(uid)), data);
  return ref.id;
};
