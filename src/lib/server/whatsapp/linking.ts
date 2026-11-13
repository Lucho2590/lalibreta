import "server-only";

import { randomInt } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../firebase-admin";

/**
 * Vinculación número de WhatsApp <-> usuario.
 *
 * - whatsappLinkCodes/{code}: { uid, expiresAt } — código de 6 dígitos que
 *   genera la web y el usuario manda por WhatsApp ("vincular 123456").
 *   Que el mensaje llegue desde ese número prueba que el número es suyo.
 * - whatsappLinks/{waId}: { uid, linkedAt, profileName } — un número, un usuario.
 *
 * No guardamos el teléfono en users/{uid} porque ese doc lo puede leer
 * cualquier usuario autenticado.
 */

const CODES = "whatsappLinkCodes";
const LINKS = "whatsappLinks";
const SESSIONS = "whatsappSessions";
const CODE_TTL_MS = 10 * 60 * 1000;

export const createLinkCode = async (
  uid: string,
): Promise<{ code: string; expiresAt: Date }> => {
  const db = adminDb();

  // Un solo código vigente por usuario.
  const previous = await db.collection(CODES).where("uid", "==", uid).get();
  const batch = db.batch();
  previous.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();

  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await db
        .collection(CODES)
        .doc(code)
        .create({ uid, expiresAt: Timestamp.fromDate(expiresAt) });
      return { code, expiresAt };
    } catch {
      // Colisión con un código existente: probamos otro.
    }
  }
  throw new Error("No se pudo generar un código de vinculación");
};

export type ConsumeResult =
  | { ok: true; uid: string }
  | { ok: false; reason: "invalid" | "expired" };

export const consumeLinkCode = async (
  code: string,
  waId: string,
  profileName: string | null,
): Promise<ConsumeResult> => {
  const db = adminDb();
  return db.runTransaction(async (tx) => {
    const codeRef = db.collection(CODES).doc(code);
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) return { ok: false, reason: "invalid" } as const;
    const data = codeSnap.data() as { uid: string; expiresAt: Timestamp };
    if (data.expiresAt.toMillis() < Date.now()) {
      tx.delete(codeRef);
      return { ok: false, reason: "expired" } as const;
    }

    // Si el usuario ya tenía otro número vinculado, lo reemplazamos.
    const previous = await tx.get(
      db.collection(LINKS).where("uid", "==", data.uid),
    );
    previous.docs.forEach((d) => {
      if (d.id !== waId) {
        tx.delete(d.ref);
        tx.delete(db.collection(SESSIONS).doc(d.id));
      }
    });

    tx.set(db.collection(LINKS).doc(waId), {
      uid: data.uid,
      profileName,
      linkedAt: FieldValue.serverTimestamp(),
    });
    // Sesión nueva: si el número estaba vinculado a otra persona, no
    // arrastramos su historial ni borradores.
    tx.delete(db.collection(SESSIONS).doc(waId));
    tx.delete(codeRef);
    return { ok: true, uid: data.uid } as const;
  });
};

export const getLinkedUid = async (waId: string): Promise<string | null> => {
  const snap = await adminDb().collection(LINKS).doc(waId).get();
  if (!snap.exists) return null;
  return (snap.data() as { uid: string }).uid;
};

export const getLinkForUser = async (
  uid: string,
): Promise<{ waId: string; linkedAt: Date | null } | null> => {
  const snap = await adminDb()
    .collection(LINKS)
    .where("uid", "==", uid)
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return null;
  const linkedAt = (doc.data().linkedAt as Timestamp | undefined)?.toDate() ?? null;
  return { waId: doc.id, linkedAt };
};

export const unlinkUser = async (uid: string): Promise<number> => {
  const db = adminDb();
  const snap = await db.collection(LINKS).where("uid", "==", uid).get();
  const batch = db.batch();
  snap.docs.forEach((d) => {
    batch.delete(d.ref);
    batch.delete(db.collection(SESSIONS).doc(d.id));
  });
  await batch.commit();
  return snap.size;
};
