import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { listAgenda } from "./activities";
import { todayYMD } from "./time";
import { buildICalendar } from "@/lib/domain/ical";
import { activityToEvent } from "@/lib/domain/activity-calendar";
import type { Activity } from "@/lib/domain/activity-model";

/**
 * Suscripción a la agenda desde Google Calendar / iPhone / Outlook.
 *
 * Cada usuario tiene un link privado `/api/agenda/ics/<token>.ics`. Los
 * calendarios no pueden mandar login, así que el token ES la llave: largo,
 * aleatorio y se puede regenerar (el viejo deja de andar). Va en
 * `calendarFeeds/{token}` (solo server), no en users/{uid}, que lo puede
 * leer cualquier usuario logueado.
 */

const feedsCol = () => adminDb().collection("calendarFeeds");

/** Cuánto para atrás se incluye (lo futuro va todo). */
const PAST_DAYS = 90;

const newToken = () => randomBytes(24).toString("base64url");

/** Dominio fijo para el UID de cada evento (si cambiara, los calendarios duplicarían todo). */
const UID_DOMAIN = "lalibreta.com.ar";

export const getOrCreateFeedToken = async (uid: string): Promise<string> => {
  const existing = await feedsCol().where("uid", "==", uid).limit(1).get();
  if (!existing.empty) return existing.docs[0].id;
  const token = newToken();
  await feedsCol().doc(token).set({ uid, createdAt: FieldValue.serverTimestamp() });
  return token;
};

/** Link nuevo: el anterior deja de funcionar en todos los calendarios donde se agregó. */
export const resetFeedToken = async (uid: string): Promise<string> => {
  const existing = await feedsCol().where("uid", "==", uid).get();
  const batch = adminDb().batch();
  existing.docs.forEach((d) => batch.delete(d.ref));
  const token = newToken();
  batch.set(feedsCol().doc(token), { uid, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return token;
};

export const uidForFeedToken = async (token: string): Promise<string | null> => {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const snap = await feedsCol().doc(token).get();
  if (!snap.exists) return null;
  void snap.ref.update({ lastFetchedAt: FieldValue.serverTimestamp() }).catch(() => {});
  return (snap.data()?.uid as string | undefined) ?? null;
};

const addDays = (ymd: string, days: number) =>
  todayYMD(new Date(new Date(`${ymd}T12:00:00-03:00`).getTime() + days * 86_400_000));

/** Las actividades a las que va (suyas o aceptadas), de los últimos 90 días en adelante. */
const goingActivities = async (uid: string) =>
  (await listAgenda(uid, addDays(todayYMD(), -PAST_DAYS), "9999-12-31")).filter((a) => {
    const me = a.participants.find((p) => p.uid === uid);
    return me?.status === "owner" || me?.status === "accepted";
  });

export const buildUserCalendar = async (uid: string, appUrl: string): Promise<string> => {
  const events = (await goingActivities(uid)).map((a) => activityToEvent(a, uid, appUrl));
  return buildICalendar(events, { name: "La Libreta", domain: UID_DOMAIN });
};

/** Una sola actividad (botón "Agregar al calendario" del celular). */
export const buildSingleEventCalendar = async (
  uid: string,
  activityId: string,
  appUrl: string,
): Promise<string | null> => {
  const snap = await adminDb().collection("activities").doc(activityId).get();
  if (!snap.exists) return null;
  const a = { id: snap.id, ...snap.data() } as Activity;
  const me = a.participants?.find((p) => p.uid === uid);
  if (!me || me.status === "rejected") return null;
  return buildICalendar([activityToEvent(a, uid, appUrl)], { name: a.title, domain: UID_DOMAIN });
};
