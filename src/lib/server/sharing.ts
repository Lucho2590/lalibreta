import "server-only";

import { randomInt } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { loadAccounts, type ServerAccountInfo } from "./queries-admin";
import { notify } from "./notifications";

/**
 * Cuentas compartidas con código.
 *
 * - accountShareCodes/{code}: { ownerUid, ownerName, accounts: [{ accountId, accountName }], expiresAt }
 *   código de 6 dígitos (vence en 24 h, se usa una vez) que puede cubrir una o
 *   varias cuentas. Se genera desde el agente o desde la app, y la otra persona
 *   lo canjea reenviándole el mensaje a su agente o desde la app.
 * - accountShares/{id}: mismo esquema que la web (compartir por email), con
 *   mode "direct": lo que carga la otra persona entra directo a la cuenta del
 *   dueño (sin aprobación) y se le avisa.
 */

const CODES = "accountShareCodes";
const SHARES = "accountShares";
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

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

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;

/**
 * El mensaje que el dueño reenvía tal cual. Quien lo recibe se lo reenvía a su
 * agente (lo reconoce solo) o entra al link de la app.
 */
export const shareInviteMessage = (ownerName: string, accountNames: string[], code: string) => {
  const cuentas = joinNames(accountNames.map((n) => `*${n}*`));
  const first = ownerName.split(" ")[0] || ownerName;
  return [
    `🤝 *${first}* te compartió ${accountNames.length > 1 ? "sus cuentas" : "su cuenta"} ${cuentas} en La Libreta.`,
    "",
    "Para sumarte, reenviale este mensaje a tu agente de WhatsApp o entrá acá:",
    `${appUrl()}/unirme?codigo=${code}`,
    "",
    `Código para unirte: *${code}* (vale 24 h)`,
  ].join("\n");
};

/**
 * Busca un código de cuenta compartida en un mensaje de WhatsApp: el mensaje de
 * invitación reenviado, "unirme 123456" o el código solo.
 */
const INVITE_CODE_RE = /c[oó]digo para unirte:\s*\*?(\d{6})\*?/i;
const BARE_CODE_RE = /^\s*(unirme(?:\s+a\s+la\s+cuenta\s+compartida)?\s*)?(\d{6})\s*[.!]?\s*$/i;
/** `explicit`: seguro es un código para unirse (no un número suelto que podría ser un monto). */
export const findShareCodeInText = (text: string): { code: string; explicit: boolean } | null => {
  const invite = INVITE_CODE_RE.exec(text);
  if (invite) return { code: invite[1], explicit: true };
  const bare = BARE_CODE_RE.exec(text);
  if (bare) return { code: bare[2], explicit: Boolean(bare[1]) };
  return null;
};

export const shareCodeExists = async (code: string) =>
  (await adminDb().collection(CODES).doc(code).get()).exists;

export const createShareCode = async (
  ownerUid: string,
  accounts: Array<{ id: string; name: string }>,
): Promise<{ code: string; expiresAt: Date; message: string }> => {
  if (accounts.length === 0) throw new Error("Sin cuentas para compartir");
  const db = adminDb();
  const owner = await userName(ownerUid);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await db.collection(CODES).doc(code).create({
        ownerUid,
        ownerName: owner.name,
        accounts: accounts.map((a) => ({ accountId: a.id, accountName: a.name })),
        expiresAt: Timestamp.fromDate(expiresAt),
      });
      const message = shareInviteMessage(owner.name, accounts.map((a) => a.name), code);
      return { code, expiresAt, message };
    } catch {
      // Colisión: probamos otro código.
    }
  }
  throw new Error("No se pudo generar el código");
};

export type RedeemResult =
  | { ok: true; ownerUid: string; ownerName: string; joined: SharedWithMe[]; alreadyHad: SharedWithMe[] }
  | { ok: false; reason: "invalid" | "expired" | "own" | "account-gone" | "too-many" };

interface CodeDoc {
  ownerUid: string;
  ownerName: string;
  accounts?: Array<{ accountId: string; accountName: string }>;
  // Formato viejo (una sola cuenta).
  accountId?: string;
  accountName?: string;
  expiresAt: Timestamp;
}

export const redeemShareCode = async (granteeUid: string, code: string): Promise<RedeemResult> => {
  const db = adminDb();
  const codeRef = db.collection(CODES).doc(code);
  const snap = await codeRef.get();
  if (!snap.exists) return { ok: false, reason: "invalid" };
  const c = snap.data() as CodeDoc;
  if (c.expiresAt.toMillis() < Date.now()) {
    await codeRef.delete();
    return { ok: false, reason: "expired" };
  }
  if (c.ownerUid === granteeUid) return { ok: false, reason: "own" };

  const wanted =
    c.accounts ?? (c.accountId ? [{ accountId: c.accountId, accountName: c.accountName ?? "" }] : []);
  const accSnaps = await Promise.all(
    wanted.map((w) => db.doc(`users/${c.ownerUid}/accounts/${w.accountId}`).get()),
  );
  const live = accSnaps.filter((s) => s.exists);
  if (live.length === 0) {
    await codeRef.delete();
    return { ok: false, reason: "account-gone" };
  }

  const [owner, grantee, existing] = await Promise.all([
    userName(c.ownerUid),
    userName(granteeUid),
    db
      .collection(SHARES)
      .where("ownerUid", "==", c.ownerUid)
      .where("granteeUid", "==", granteeUid)
      .where("status", "==", "active")
      .get(),
  ]);
  const existingByAccount = new Map(existing.docs.map((d) => [String(d.data().accountId), d.id]));

  const joined: SharedWithMe[] = [];
  const alreadyHad: SharedWithMe[] = [];
  const batch = db.batch();
  for (const accSnap of live) {
    const acc = accSnap.data() as { name: string; icon?: string | null; type: string };
    const base = {
      ownerUid: c.ownerUid,
      ownerName: c.ownerName,
      accountId: accSnap.id,
      accountName: acc.name,
      accountType: acc.type,
    };
    // ¿Ya la compartían? (no duplicamos)
    const prev = existingByAccount.get(accSnap.id);
    if (prev) {
      alreadyHad.push({ shareId: prev, ...base });
      continue;
    }
    const ref = db.collection(SHARES).doc();
    batch.set(ref, {
      ownerUid: c.ownerUid,
      ownerEmail: owner.email,
      ownerDisplayName: owner.name,
      accountId: accSnap.id,
      accountName: acc.name,
      accountIcon: acc.icon ?? null,
      accountType: acc.type,
      granteeEmail: grantee.email,
      granteeUid,
      granteeDisplayName: grantee.name,
      status: "active",
      mode: "direct",
      source: "code",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    joined.push({ shareId: ref.id, ...base });
  }
  batch.delete(codeRef);
  await batch.commit();
  return { ok: true, ownerUid: c.ownerUid, ownerName: c.ownerName, joined, alreadyHad };
};

export const REDEEM_ERRORS: Record<Exclude<RedeemResult, { ok: true }>["reason"], string> = {
  invalid: "Ese código no existe o ya se usó. Pedile a la otra persona que te comparta uno nuevo.",
  expired: "Ese código venció (duran 24 h). Pedile a la otra persona uno nuevo.",
  own: "Ese código es de una cuenta tuya: se lo tenés que pasar a la otra persona.",
  "account-gone": "La cuenta de ese código ya no existe.",
  "too-many": "Probaste demasiados códigos. Esperá un rato y volvé a intentar.",
};

// Freno a probar códigos al azar: hasta 10 inválidos por hora por usuario.
const FAILS = "shareCodeFails";
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 60 * 60 * 1000;

const tooManyFails = async (uid: string) => {
  const d = (await adminDb().collection(FAILS).doc(uid).get()).data();
  return !!d && Date.now() - Number(d.since) < FAIL_WINDOW_MS && Number(d.count) >= MAX_FAILS;
};

const recordFail = async (uid: string) => {
  const ref = adminDb().collection(FAILS).doc(uid);
  await adminDb().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    const fresh = !d || Date.now() - Number(d.since) >= FAIL_WINDOW_MS;
    tx.set(ref, fresh ? { since: Date.now(), count: 1 } : { since: d.since, count: Number(d.count) + 1 });
  });
};

/** Canjea el código y le avisa al dueño. Lo usan el agente, el webhook y la app. */
export const joinWithCode = async (granteeUid: string, code: string): Promise<RedeemResult> => {
  if (await tooManyFails(granteeUid)) return { ok: false, reason: "too-many" };
  const r = await redeemShareCode(granteeUid, code);
  if (!r.ok && r.reason === "invalid") await recordFail(granteeUid).catch(() => {});
  if (r.ok && r.joined.length > 0) {
    const me = await displayNameOf(granteeUid);
    const names = joinNames(r.joined.map((s) => s.accountName));
    await notify(r.ownerUid, {
      kind: "share-joined",
      title: `${me} ya comparte tu ${names}`,
      body: "Lo que cargue ahí entra directo a tu cuenta y te aviso.",
      url: `/cuentas/${r.joined[0].accountId}`,
      whatsappText: `🤝 *${me}* ya comparte tu *${names}*. Lo que cargue ahí entra directo y te aviso.`,
    }).catch((err) => console.warn("[sharing] aviso al dueño falló", err));
  }
  return r;
};

/** Texto de confirmación para quien se unió. */
export const joinedMessage = (r: Extract<RedeemResult, { ok: true }>) => {
  const all = [...r.joined, ...r.alreadyHad];
  const names = joinNames(all.map((s) => `*${s.accountName}*`));
  const owner = r.ownerName.split(" ")[0] || r.ownerName;
  if (r.joined.length === 0) return `Ya tenías acceso a ${names} de ${owner} 👌`;
  return `🤝 ¡Listo! Ya compartís ${names} de ${owner}.\n\nPodés cargar gastos ("gasté 20 lucas en el super con la ${all[0].accountName}") y consultarla. Lo que cargues entra directo y le aviso.`;
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
