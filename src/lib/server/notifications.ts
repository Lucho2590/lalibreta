import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { WebPushError, sendNotification, setVapidDetails, type PushSubscription } from "web-push";
import { adminDb } from "./firebase-admin";
import { sendText } from "./whatsapp/client";
import { withDefaultPrefs, type NotificationKind } from "@/lib/domain/notifications";

/**
 * Avisos al usuario. Cada aviso:
 * 1. Queda en la bandeja de la app (`users/{uid}/notifications`).
 * 2. Llega como notificación push a los dispositivos donde la activó.
 * 3. Si no le llegó a ningún dispositivo y le habló al bot en las últimas
 *    24 h (la ventana que permite WhatsApp), va también por WhatsApp.
 */

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body: string;
  /** A dónde lleva el aviso al tocarlo. */
  url?: string;
  /** Texto para WhatsApp (con *negritas*). Si falta, no se manda por WhatsApp. */
  whatsappText?: string;
  /** Evita repetir el mismo aviso (ej. el vencimiento de un resumen). */
  dedupeKey?: string;
}

export interface NotifyResult {
  stored: boolean;
  pushed: number;
  whatsapp: boolean;
}

const WA_WINDOW_MS = 23.5 * 60 * 60 * 1000;

let vapidReady: boolean | null = null;
const ensureVapid = (): boolean => {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.warn("[notify] faltan las claves VAPID: no se mandan push");
    vapidReady = false;
    return false;
  }
  setVapidDetails(process.env.VAPID_SUBJECT || "mailto:avisos@lalibreta.app", pub, priv);
  vapidReady = true;
  return true;
};

export const subscriptionId = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("hex").slice(0, 40);

const subsCol = (uid: string) => adminDb().collection("users").doc(uid).collection("pushSubscriptions");
const notifCol = (uid: string) => adminDb().collection("users").doc(uid).collection("notifications");

export const savePushSubscription = async (
  uid: string,
  sub: PushSubscription,
  userAgent: string | null,
): Promise<string> => {
  const id = subscriptionId(sub.endpoint);
  await subsCol(uid).doc(id).set(
    {
      endpoint: sub.endpoint,
      keys: sub.keys,
      userAgent: userAgent?.slice(0, 300) ?? null,
      createdAt: FieldValue.serverTimestamp(),
      lastUsedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return id;
};

export const deletePushSubscription = async (uid: string, endpoint: string) => {
  await subsCol(uid).doc(subscriptionId(endpoint)).delete();
};

/** Manda un push a todos los dispositivos del usuario. Devuelve a cuántos llegó. */
export const sendPushToUser = async (
  uid: string,
  payload: { title: string; body: string; url?: string; tag?: string; id?: string },
): Promise<number> => {
  if (!ensureVapid()) return 0;
  const subs = await subsCol(uid).get();
  if (subs.empty) return 0;
  const body = JSON.stringify(payload);
  const results = await Promise.all(
    subs.docs.map(async (doc) => {
      const data = doc.data() as PushSubscription;
      try {
        await sendNotification({ endpoint: data.endpoint, keys: data.keys }, body, { TTL: 60 * 60 * 24 });
        return true;
      } catch (err) {
        // 404/410: la suscripción ya no existe (desinstaló, bloqueó o expiró).
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          await doc.ref.delete().catch(() => {});
        } else {
          console.warn("[notify] push falló", uid, err instanceof Error ? err.message : err);
        }
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
};

/** ¿Le escribió al bot hace poco? (fuera de 24 h WhatsApp no deja escribirle). */
const whatsappTarget = async (uid: string): Promise<string | null> => {
  const link = await adminDb().collection("whatsappLinks").where("uid", "==", uid).limit(1).get();
  const waId = link.docs[0]?.id;
  if (!waId) return null;
  const session = await adminDb().collection("whatsappSessions").doc(waId).get();
  const updatedAt = (session.data()?.updatedAt as number | undefined) ?? 0;
  return Date.now() - updatedAt < WA_WINDOW_MS ? waId : null;
};

export const notify = async (uid: string, input: NotifyInput): Promise<NotifyResult> => {
  const result: NotifyResult = { stored: false, pushed: 0, whatsapp: false };
  try {
    const ref = input.dedupeKey ? notifCol(uid).doc(input.dedupeKey) : notifCol(uid).doc();
    if (input.dedupeKey && (await ref.get()).exists) return result;
    await ref.set({
      kind: input.kind,
      title: input.title,
      body: input.body,
      url: input.url ?? "/",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    result.stored = true;
    // Los avisos de cuentas compartidas se pueden apagar (quedan solo en la bandeja).
    if (input.kind.startsWith("share") || input.kind === "shared-expense") {
      const prefs = withDefaultPrefs((await adminDb().collection("users").doc(uid).get()).data()?.notificationPrefs);
      if (!prefs.shared) return result;
    }
    result.pushed = await sendPushToUser(uid, {
      title: input.title,
      body: input.body,
      url: input.url ?? "/",
      tag: input.dedupeKey ?? ref.id,
      id: ref.id,
    });
    if (result.pushed === 0 && input.whatsappText) {
      const waId = await whatsappTarget(uid);
      if (waId) {
        await sendText(waId, input.whatsappText);
        result.whatsapp = true;
      }
    }
  } catch (err) {
    console.warn("[notify] no se pudo avisar", uid, err);
  }
  return result;
};
