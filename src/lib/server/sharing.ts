import "server-only";

import { randomInt } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { sendText } from "./whatsapp/client";
import { loadAccounts, type ServerAccountInfo } from "./queries-admin";

/**
 * Cuentas compartidas por WhatsApp con código.
 *
 * - accountShareCodes/{code}: { ownerUid, accountId, accountName, ownerName, expiresAt }
 *   código de 6 dígitos que el dueño le pasa a la otra persona (vence en 24 h,
 *   se usa una vez).
 * - accountShares/{id}: mismo esquema que la web (compartir por email), con
 *   mode "direct": lo que carga la otra persona entra directo a la cuenta del
 *   dueño (sin aprobación) y se le avisa.
 */

const CODES = "accountShareCodes";
const SHARES = "accountShares";
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SharedWithMe {
  shareId: string;
  ownerUid: string;
  ownerName: string;
  accountId: string;
  accountName: string;
  accountType: string;
}

export interface MyShare {
  shareId: string;
  accountId: string;
  accountName: string;
  granteeUid: string | null;
  granteeName: string;
}

const userName = async (uid: string): Promise<{ name: string; email: string | null }> => {
  const d = (await adminDb().collection("users").doc(uid).get()).data() ?? {};
  const email = (d.email as string | undefined) ?? null;
  const name = (d.displayName as string | undefined) ?? email?.split("@")[0] ?? "Alguien";
  return { name, email };
};

export const createShareCode = async (
  ownerUid: string,
  account: { id: string; name: string },
): Promise<{ code: string; expiresAt: Date }> => {
  const db = adminDb();
  const owner = await userName(ownerUid);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await db.collection(CODES).doc(code).create({
        ownerUid,
        ownerName: owner.name,
        accountId: account.id,
        accountName: account.name,
        expiresAt: Timestamp.fromDate(expiresAt),
      });
      return { code, expiresAt };
    } catch {
      // Colisión: probamos otro código.
    }
  }
  throw new Error("No se pudo generar el código");
};

export type RedeemResult =
  | { ok: true; share: SharedWithMe; alreadyHad: boolean }
  | { ok: false; reason: "invalid" | "expired" | "own" | "account-gone" };

export const redeemShareCode = async (granteeUid: string, code: string): Promise<RedeemResult> => {
  const db = adminDb();
  const codeRef = db.collection(CODES).doc(code);
  const snap = await codeRef.get();
  if (!snap.exists) return { ok: false, reason: "invalid" };
  const c = snap.data() as {
    ownerUid: string;
    ownerName: string;
    accountId: string;
    accountName: string;
    expiresAt: Timestamp;
  };
  if (c.expiresAt.toMillis() < Date.now()) {
    await codeRef.delete();
    return { ok: false, reason: "expired" };
  }
  if (c.ownerUid === granteeUid) return { ok: false, reason: "own" };

  const accSnap = await db.doc(`users/${c.ownerUid}/accounts/${c.accountId}`).get();
  if (!accSnap.exists) {
    await codeRef.delete();
    return { ok: false, reason: "account-gone" };
  }
  const acc = accSnap.data() as { name: string; icon?: string | null; type: string };

  const share: Omit<SharedWithMe, "shareId"> = {
    ownerUid: c.ownerUid,
    ownerName: c.ownerName,
    accountId: c.accountId,
    accountName: acc.name,
    accountType: acc.type,
  };

  // ¿Ya la compartían? (no duplicamos)
  const existing = await db
    .collection(SHARES)
    .where("ownerUid", "==", c.ownerUid)
    .where("accountId", "==", c.accountId)
    .where("granteeUid", "==", granteeUid)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (!existing.empty) {
    await codeRef.delete();
    return { ok: true, share: { shareId: existing.docs[0].id, ...share }, alreadyHad: true };
  }

  const [owner, grantee] = await Promise.all([userName(c.ownerUid), userName(granteeUid)]);
  const ref = db.collection(SHARES).doc();
  const batch = db.batch();
  batch.set(ref, {
    ownerUid: c.ownerUid,
    ownerEmail: owner.email,
    ownerDisplayName: owner.name,
    accountId: c.accountId,
    accountName: acc.name,
    accountIcon: acc.icon ?? null,
    accountType: acc.type,
    granteeEmail: grantee.email,
    granteeUid,
    granteeDisplayName: grantee.name,
    status: "active",
    mode: "direct",
    source: "whatsapp",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.delete(codeRef);
  await batch.commit();
  return { ok: true, share: { shareId: ref.id, ...share }, alreadyHad: false };
};

/** Cuentas de otros compartidas conmigo (activas). */
export const loadSharedWithMe = async (uid: string): Promise<SharedWithMe[]> => {
  const snap = await adminDb()
    .collection(SHARES)
    .where("granteeUid", "==", uid)
    .where("status", "==", "active")
    .get();
  return snap.docs.map((d) => {
    const s = d.data();
    return {
      shareId: d.id,
      ownerUid: String(s.ownerUid),
      ownerName: String(s.ownerDisplayName ?? s.ownerEmail ?? "Alguien"),
      accountId: String(s.accountId),
      accountName: String(s.accountName),
      accountType: String(s.accountType ?? ""),
    };
  });
};

/** Cuentas mías que compartí con otros (activas). */
export const loadMyShares = async (uid: string): Promise<MyShare[]> => {
  const snap = await adminDb()
    .collection(SHARES)
    .where("ownerUid", "==", uid)
    .where("status", "==", "active")
    .get();
  return snap.docs.map((d) => {
    const s = d.data();
    return {
      shareId: d.id,
      accountId: String(s.accountId),
      accountName: String(s.accountName),
      granteeUid: (s.granteeUid as string | null) ?? null,
      granteeName: String(s.granteeDisplayName ?? s.granteeEmail ?? "Alguien"),
    };
  });
};

/** Corta un compartido (lo puede hacer el dueño o quien lo recibió). */
export const revokeShare = async (
  uid: string,
  shareId: string,
): Promise<{ ok: boolean; share?: { ownerUid: string; granteeUid: string | null; accountName: string } }> => {
  const ref = adminDb().collection(SHARES).doc(shareId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false };
  const s = snap.data() as { ownerUid: string; granteeUid: string | null; accountName: string };
  if (s.ownerUid !== uid && s.granteeUid !== uid) return { ok: false };
  await ref.update({ status: "revoked", updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, share: s };
};

/**
 * Le manda un WhatsApp a otro usuario (si tiene el número vinculado).
 * Ojo: WhatsApp solo permite texto libre si esa persona le escribió al bot en
 * las últimas 24 h; si no, Meta lo rechaza (haría falta una plantilla
 * aprobada). Es best-effort: no falla la operación principal.
 */
export const notifyUser = async (uid: string, text: string): Promise<boolean> => {
  try {
    const link = await adminDb().collection("whatsappLinks").where("uid", "==", uid).limit(1).get();
    const waId = link.docs[0]?.id;
    if (!waId) return false;
    await sendText(waId, text);
    return true;
  } catch (err) {
    console.warn("[share] no se pudo avisar al usuario", uid, err);
    return false;
  }
};

export const displayNameOf = async (uid: string) => (await userName(uid)).name;

/** Cuentas compartidas conmigo + los datos de la cuenta del dueño (moneda, cierre…). */
export const loadSharedAccounts = async (
  uid: string,
): Promise<Array<SharedWithMe & { account: ServerAccountInfo }>> => {
  const shares = await loadSharedWithMe(uid);
  const byOwner = new Map<string, ServerAccountInfo[]>();
  for (const ownerUid of new Set(shares.map((s) => s.ownerUid))) {
    byOwner.set(ownerUid, await loadAccounts(ownerUid));
  }
  return shares
    .map((s) => ({ ...s, account: byOwner.get(s.ownerUid)?.find((a) => a.id === s.accountId) }))
    .filter((s): s is SharedWithMe & { account: ServerAccountInfo } => !!s.account && s.account.active);
};
