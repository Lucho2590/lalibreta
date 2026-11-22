import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { WebPushError, sendNotification, setVapidDetails, type PushSubscription } from "web-push";
import { adminDb } from "./firebase-admin";
import { sendTemplate, sendText } from "./whatsapp/client";
import { withDefaultPrefs, type NotificationKind } from "@/lib/domain/notifications";

/**
 * Avisos al usuario. Cada aviso:
 * 1. Queda en la bandeja de la app (`users/{uid}/notifications`).
 * 2. Llega como notificación push a los dispositivos donde la activó.
 * 3. Por WhatsApp:
 *    - si activó la copia por WhatsApp (`whatsappCopy`), siempre. Fuera de las
 *      24 h desde su último mensaje al bot, va con la plantilla aprobada.
 *    - si no, solo si el push no llegó a ningún dispositivo y le habló al bot
 *      en las últimas 24 h (la ventana que permite WhatsApp).
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
/**
 * Avisos que el usuario borró de la bandeja. Se guarda solo la marca para que
 * los avisos con dedupeKey (vencimientos, alertas del clima) no vuelvan a
 * llegar por haber desaparecido el original.
 */
export const dismissedCol = (uid: string) =>
  adminDb().collection("users").doc(uid).collection("dismissedNotifications");

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

/** Número de WhatsApp vinculado y si está dentro de las 24 h (cuando WhatsApp deja escribir libre). */
const whatsappTarget = async (uid: string): Promise<{ waId: string; inWindow: boolean } | null> => {
  const link = await adminDb().collection("whatsappLinks").where("uid", "==", uid).limit(1).get();
  const waId = link.docs[0]?.id;
  if (!waId) return null;
  const session = await adminDb().collection("whatsappSessions").doc(waId).get();
  const updatedAt = (session.data()?.updatedAt as number | undefined) ?? 0;
  return { waId, inWindow: Date.now() - updatedAt < WA_WINDOW_MS };
};

/**
 * Plantilla aprobada en Meta para los avisos, con dos variables: {{1}} el
 * título y {{2}} el detalle. Sin ella, fuera de las 24 h no sale nada.
 */
export const noticeTemplate = () => {
  const name = process.env.WHATSAPP_NOTICE_TEMPLATE;
  return name ? { name, language: process.env.WHATSAPP_NOTICE_TEMPLATE_LANG || "es_AR" } : null;
};

/** En cuántos dispositivos tiene activados los avisos push. */
export const countPushDevices = async (uid: string): Promise<number> =>
  (await subsCol(uid).count().get()).data().count;

/**
 * Manda el aviso por WhatsApp. Dentro de las 24 h va como texto común (gratis).
 * Fuera de las 24 h solo sale con plantilla.
 * - `copy`: la copia que pidió el usuario para el reloj. Texto plano y corto
 *   (en la notificación los *asteriscos* se ven tal cual) y usa la plantilla.
 * - si no, es el respaldo de siempre: el `whatsappText` y solo dentro de las 24 h.
 */
const sendWhatsappNotice = async (uid: string, input: NotifyInput, copy: boolean): Promise<boolean> => {
  const target = await whatsappTarget(uid);
  if (!target) return false;
  try {
    if (target.inWindow) {
      const text = copy || !input.whatsappText ? `📒 ${input.title}\n${input.body}` : input.whatsappText;
      await sendText(target.waId, text);
      return true;
    }
    const template = copy ? noticeTemplate() : null;
    if (!template) return false;
    await sendTemplate(target.waId, template.name, template.language, [input.title, input.body]);
    return true;
  } catch (err) {
    console.warn("[notify] WhatsApp falló", uid, err instanceof Error ? err.message : err);
    return false;
  }
};

export const notify = async (uid: string, input: NotifyInput): Promise<NotifyResult> => {
  const result: NotifyResult = { stored: false, pushed: 0, whatsapp: false };
  try {
    const ref = input.dedupeKey ? notifCol(uid).doc(input.dedupeKey) : notifCol(uid).doc();
    if (input.dedupeKey) {
      const [existing, dismissed] = await adminDb().getAll(ref, dismissedCol(uid).doc(input.dedupeKey));
      if (existing.exists || dismissed.exists) return result;
    }
    await ref.set({
      kind: input.kind,
      title: input.title,
      body: input.body,
      url: input.url ?? "/",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    result.stored = true;
    const prefs = withDefaultPrefs((await adminDb().collection("users").doc(uid).get()).data()?.notificationPrefs);
    // Los avisos de cuentas compartidas y las respuestas de la gente se pueden
    // apagar (quedan solo en la bandeja). Las solicitudes llegan siempre.
    if (
      input.kind.startsWith("share") ||
      input.kind === "shared-expense" ||
      input.kind === "connection-response" ||
      input.kind === "split-response" ||
      input.kind === "split-cancelled" ||
      input.kind === "p2p-response" ||
      input.kind === "vaquita-payment"
    ) {
      if (!prefs.shared) return result;
    }
    result.pushed = await sendPushToUser(uid, {
      title: input.title,
      body: input.body,
      url: input.url ?? "/",
      tag: input.dedupeKey ?? ref.id,
      id: ref.id,
    });
    // Copia por WhatsApp si la pidió (para verla en el reloj), o como respaldo
    // si el push no llegó a ningún dispositivo.
    if (prefs.whatsappCopy) {
      result.whatsapp = await sendWhatsappNotice(uid, input, true);
    } else if (result.pushed === 0 && input.whatsappText) {
      result.whatsapp = await sendWhatsappNotice(uid, input, false);
    }
  } catch (err) {
    console.warn("[notify] no se pudo avisar", uid, err);
  }
  return result;
};
