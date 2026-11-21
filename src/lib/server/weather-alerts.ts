import "server-only";

import { adminDb } from "./firebase-admin";
import { dismissedCol, notify } from "./notifications";
import { listUserLocations, syncSmnAlerts, tryGetActiveAlerts, tryGetForecast, type AlertsSyncResult } from "./weather";
import { withDefaultPrefs, type NotificationPrefs } from "@/lib/domain/notifications";
import {
  LEVEL_EMOJI,
  alertDedupeKey,
  alertWindowText,
  alertsAt,
  dailySummaryText,
  placeText,
  rainWindowText,
  weatherEmoji,
  type AlertLevel,
  type UserLocation,
  type WeatherAlert,
} from "@/lib/domain/weather";

/**
 * Avisos del clima:
 * - `runWeatherAlerts`: cada 30 min (GitHub Actions → /api/cron/weather).
 *   Cruza las alertas vigentes del SMN con la ubicación de cada usuario.
 * - `weatherDailyReminders`: a la mañana, con el cron diario.
 */

const LEVELS: AlertLevel[] = ["amarilla", "naranja", "roja"];

/** Las amarillas no se mandan de noche (23 a 7 h): llegan a la mañana si siguen vigentes. */
const isQuietHour = (now: Date) => {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
  return hour >= 23 || hour < 7;
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export const alertTitle = (a: Pick<WeatherAlert, "event" | "level">) =>
  `${LEVEL_EMOJI[a.level]} Alerta ${a.level} por ${lower(a.event)}`;

const alertMessage = (a: WeatherAlert, loc: UserLocation, now: Date) => {
  const where = placeText(loc);
  const when = alertWindowText(a, now);
  const firstTip = a.instructions[0];
  const body = `${where} · ${when}.${firstTip ? ` ${firstTip}` : ""}`;
  const tips = a.instructions.slice(0, 4).map((t) => `• ${t}`).join("\n");
  const whatsappText = [
    `*${alertTitle(a)}* en ${where}`,
    `${when.charAt(0).toUpperCase()}${when.slice(1)}.`,
    a.description,
    tips,
    "_Fuente: SMN_",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { title: alertTitle(a), body, whatsappText };
};

/**
 * Para cada fenómeno+día, solo la alerta más grave. Si el SMN publica la
 * misma tormenta en varios tramos horarios, se avisa una vez.
 */
const worstPerEvent = (alerts: WeatherAlert[]) => {
  const byKey = new Map<string, WeatherAlert>();
  for (const a of alerts) {
    const key = `${a.event}|${a.onset.slice(0, 10)}`;
    const prev = byKey.get(key);
    if (!prev || LEVELS.indexOf(a.level) > LEVELS.indexOf(prev.level)) byKey.set(key, a);
  }
  return [...byKey.values()];
};

/** ¿Ya le avisamos este fenómeno ese día con un nivel igual o más grave? (aunque lo haya borrado) */
const alreadyWarned = async (uid: string, a: WeatherAlert) => {
  const col = adminDb().collection("users").doc(uid).collection("notifications");
  const keys = LEVELS.slice(LEVELS.indexOf(a.level)).map((level) => alertDedupeKey({ ...a, level }));
  const refs = keys.flatMap((key) => [col.doc(key), dismissedCol(uid).doc(key)]);
  const snaps = await adminDb().getAll(...refs);
  return snaps.some((s) => s.exists);
};

const loadPrefs = async (uids: string[]): Promise<Map<string, NotificationPrefs>> => {
  const out = new Map<string, NotificationPrefs>();
  if (uids.length === 0) return out;
  const users = adminDb().collection("users");
  for (let i = 0; i < uids.length; i += 100) {
    const snaps = await adminDb().getAll(...uids.slice(i, i + 100).map((uid) => users.doc(uid)));
    for (const s of snaps) out.set(s.id, withDefaultPrefs(s.data()?.notificationPrefs));
  }
  return out;
};

export interface WeatherAlertsRunResult {
  smn: AlertsSyncResult;
  users: number;
  sent: number;
  /** Sin mandar nada (para probar). */
  dryRun: boolean;
  preview?: Array<{ uid: string; title: string; body: string }>;
}

export const runWeatherAlerts = async (
  now = new Date(),
  opts: { dryRun?: boolean } = {},
): Promise<WeatherAlertsRunResult> => {
  const { alerts, result: smn } = await syncSmnAlerts();
  const locations = await listUserLocations();
  const prefs = await loadPrefs(locations.map((l) => l.uid));
  const quiet = isQuietHour(now);
  const preview: WeatherAlertsRunResult["preview"] = [];
  let sent = 0;

  for (const { uid, location } of locations) {
    if (!prefs.get(uid)?.weatherAlerts) continue;
    try {
      const here = worstPerEvent(alertsAt(alerts, location.lat, location.lon, now.getTime()));
      for (const a of here) {
        if (quiet && a.level === "amarilla") continue;
        if (await alreadyWarned(uid, a)) continue;
        const msg = alertMessage(a, location, now);
        if (opts.dryRun) {
          preview.push({ uid, title: msg.title, body: msg.body });
          continue;
        }
        const res = await notify(uid, {
          kind: "weather-alert",
          title: msg.title,
          body: msg.body,
          url: "/clima",
          whatsappText: msg.whatsappText,
          dedupeKey: alertDedupeKey(a),
        });
        if (res.stored) sent++;
      }
    } catch (err) {
      console.error("[weather] avisos de", uid, err);
    }
  }
  return { smn, users: locations.length, sent, dryRun: !!opts.dryRun, ...(opts.dryRun ? { preview } : {}) };
};

/** El pronóstico del día, a la mañana (lo llama el cron diario). */
export const weatherDailyReminders = async (
  today: string,
  prefsFor: (uid: string) => NotificationPrefs | null,
): Promise<number> => {
  const locations = await listUserLocations();
  const wanted = locations.filter(({ uid }) => prefsFor(uid)?.weatherDaily);
  if (wanted.length === 0) return 0;
  const alerts = await tryGetActiveAlerts();
  let sent = 0;
  for (const { uid, location } of wanted) {
    try {
      const forecast = await tryGetForecast(location.lat, location.lon);
      const day = forecast?.daily.find((d) => d.date === today);
      if (!forecast || !day) continue;
      const where = location.place ?? "tu zona";
      const rain = rainWindowText(forecast.hourly, today);
      const here = worstPerEvent(alertsAt(alerts, location.lat, location.lon));
      const alertLine = here.length > 0 ? `${here.map(alertTitle).join(" · ")}.` : "";
      const summary = dailySummaryText(day);
      const body = [summary, rain ? `${rain}.` : "", alertLine].filter(Boolean).join(" ");
      const res = await notify(uid, {
        kind: "weather-daily",
        title: `${weatherEmoji(day.weatherCode)} Hoy en ${where}: ${Math.round(day.tempMin)}° a ${Math.round(day.tempMax)}°`,
        body,
        url: "/clima",
        whatsappText: [`*${weatherEmoji(day.weatherCode)} El clima de hoy en ${where}*`, summary, rain, alertLine]
          .filter(Boolean)
          .join("\n"),
        dedupeKey: `wx-daily-${today}`,
      });
      if (res.stored) sent++;
    } catch (err) {
      console.error("[weather] pronóstico del día de", uid, err);
    }
  }
  return sent;
};
