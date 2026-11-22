import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { cleanNicknames, cleanPayAliases, contactIdFromEmail, type PayAlias } from "./contact-info";

export const contactsCollectionPath = (uid: string): string =>
  `users/${uid}/contacts`;

export { contactIdFromEmail };

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

export interface ContactInfoInput {
  /** Sin la app: su nombre. Con la app: el nombre que le pongo yo (vacío = el de su perfil). */
  name?: string | null;
  nicknames?: string[];
  payAliases?: PayAlias[];
  phone?: string | null;
}

const infoFields = (input: ContactInfoInput, mainName: string | null) => ({
  ...(input.nicknames !== undefined ? { nicknames: cleanNicknames(input.nicknames, mainName) } : {}),
  ...(input.payAliases !== undefined ? { payAliases: cleanPayAliases(input.payAliases) } : {}),
  ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
});

/**
 * Contacto de alguien que no usa la app (para repartirle gastos o anotar
 * préstamos y que la app me recuerde cobrarle). El nombre es obligatorio.
 */
export const addOfflineContact = async (
  uid: string,
  input: ContactInfoInput & { name: string; email?: string | null },
): Promise<string> => {
  const email = input.email?.trim().toLowerCase() || null;
  const name = input.name.trim();
  const data = {
    displayName: name,
    email,
    phone: null,
    linkedUid: null,
    kind: "offline" as const,
    photoURL: null,
    ...infoFields(input, name),
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

/** Edita la ficha de un contacto que ya existe (con o sin la app). */
export const saveContactInfo = async (
  uid: string,
  contact: { id: string; linkedUid?: string | null; kind?: string | null; displayName?: string | null },
  input: ContactInfoInput & { email?: string | null },
): Promise<void> => {
  const isApp = !!contact.linkedUid || contact.kind === "app";
  const name = input.name?.trim() || null;
  const nameField = isApp
    ? input.name !== undefined
      ? { customName: name && name !== contact.displayName?.trim() ? name : null }
      : {}
    : name
      ? { displayName: name }
      : {};
  await updateDoc(doc(db, `${contactsCollectionPath(uid)}/${contact.id}`), {
    ...nameField,
    ...infoFields(input, name ?? contact.displayName ?? null),
    // El email de los que usan la app es el de su cuenta: no se toca.
    ...(!isApp && input.email !== undefined ? { email: input.email?.trim().toLowerCase() || null } : {}),
    updatedAt: Timestamp.now(),
  });
};

/**
 * Contacto de alguien conectado (lo crea el server al conectarse; las
 * conexiones viejas pueden no tenerlo). Devuelve su id.
 */
export const ensureAppContact = async (
  uid: string,
  other: { uid: string; email: string; displayName: string | null; photoURL: string | null },
): Promise<string> => {
  const id = contactIdFromEmail(other.email);
  const ref = doc(db, `${contactsCollectionPath(uid)}/${id}`);
  // Sin createdAt no aparece en useContacts (ordena por ese campo).
  const exists = (await getDoc(ref)).exists();
  await setDoc(
    ref,
    {
      ...(exists ? {} : { createdAt: Timestamp.now() }),
      email: other.email.trim().toLowerCase(),
      displayName: other.displayName,
      photoURL: other.photoURL,
      linkedUid: other.uid,
      kind: "app",
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  );
  return id;
};
