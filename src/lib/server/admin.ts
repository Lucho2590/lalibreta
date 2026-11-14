import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { UnauthorizedError, getAuthedUser, type AuthedUser } from "./auth";

/**
 * Panel de administrador. Para entrar hacen falta las dos cosas:
 * 1. Estar logueado con un email de ADMIN_EMAILS.
 * 2. El PIN (ADMIN_PIN). Con 5 errores se bloquea 15 minutos.
 * Al acertar el PIN se entrega un token firmado que dura 12 h y viaja en el
 * header `X-Admin-Token`.
 */

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const adminEmails = () =>
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const secret = () => {
  const s = process.env.ADMIN_SESSION_SECRET || process.env.CRON_SECRET;
  if (!s) throw new Error("Falta ADMIN_SESSION_SECRET (o CRON_SECRET)");
  return s;
};

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const isAdminEmail = (email: string | null) => !!email && adminEmails().includes(email.toLowerCase());

export class ForbiddenError extends Error {
  constructor(message = "No autorizado") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export type UnlockResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: "wrong-pin" | "locked"; retryInMinutes?: number };

/** Verifica el PIN del usuario logueado y devuelve el token de sesión. */
export const unlockAdmin = async (user: AuthedUser, pin: string): Promise<UnlockResult> => {
  const ref = adminDb().collection("adminPinAttempts").doc(user.uid);
  const snap = await ref.get();
  const lockedUntil = (snap.data()?.lockedUntil as number | undefined) ?? 0;
  if (lockedUntil > Date.now()) {
    return { ok: false, reason: "locked", retryInMinutes: Math.ceil((lockedUntil - Date.now()) / 60000) };
  }
  const expected = process.env.ADMIN_PIN;
  // Un email que no es admin recibe la misma respuesta que un PIN incorrecto.
  if (!expected || !isAdminEmail(user.email) || !safeEqual(pin, expected)) {
    const fails = ((snap.data()?.fails as number | undefined) ?? 0) + 1;
    await ref.set(
      fails >= MAX_FAILS
        ? { fails: 0, lockedUntil: Date.now() + LOCK_MS, updatedAt: FieldValue.serverTimestamp() }
        : { fails, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    console.warn("[admin] PIN incorrecto", user.uid, user.email);
    return fails >= MAX_FAILS
      ? { ok: false, reason: "locked", retryInMinutes: LOCK_MS / 60000 }
      : { ok: false, reason: "wrong-pin" };
  }
  await ref.delete().catch(() => {});
  const expiresAt = Date.now() + SESSION_MS;
  const payload = `${user.uid}.${expiresAt}`;
  return { ok: true, token: `${payload}.${sign(payload)}`, expiresAt };
};

/** Para las rutas /api/admin/*: usuario admin + token de PIN vigente. */
export const requireAdmin = async (req: Request): Promise<AuthedUser> => {
  const user = await getAuthedUser(req);
  if (!isAdminEmail(user.email)) throw new ForbiddenError();
  const token = req.headers.get("x-admin-token") ?? "";
  const [uid, exp, sig] = token.split(".");
  if (!uid || !exp || !sig || uid !== user.uid || Number(exp) < Date.now()) {
    throw new ForbiddenError("Sesión de administrador vencida");
  }
  if (!safeEqual(sig, sign(`${uid}.${exp}`))) throw new ForbiddenError();
  return user;
};

/** Respuesta estándar para errores de auth en rutas de admin. */
export const adminErrorResponse = (err: unknown): Response | null => {
  if (err instanceof UnauthorizedError) return Response.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403 });
  return null;
};
