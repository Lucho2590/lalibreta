import "server-only";

import { createHash } from "node:crypto";
import type { WriteBatch } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { APP_TIMEZONE } from "./time";
import {
  alertsAt,
  coarse,
  distanceKm,
  isActive,
  levelFor,
  parseCapPolygon,
  serializePolygon,
  splitInstructions,
  summarizeAlert,
  toSeverity,
  type Forecast,
  type UserLocation,
  type WeatherAlert,
  type WeatherReport,
} from "@/lib/domain/weather";

/**
 * Clima y alertas.
 *
 * - Alertas: feed CAP oficial del SMN (sin clave, CC BY 4.0 → "Fuente: SMN").
 *   El RSS trae un item por zona y cada item linkea a un XML CAP con el
 *   polígono. Los XML se bajan una sola vez y quedan en `weatherAlerts/*`;
 *   en cada sincronización solo se bajan los nuevos y se borran los que el
 *   SMN sacó del feed.
 * - Pronóstico: Open-Meteo (sin clave).
 * - Nombre del lugar: Georef (datos.gob.ar, sin clave).
 *
 * La ubicación de cada usuario va en `userLocations/{uid}` (solo server):
 * `users/{uid}` lo puede leer cualquier usuario logueado.
 */

const SMN_FEED = "https://ssl.smn.gob.ar/CAP/AR.php";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";
const GEOREF = "https://apis.datos.gob.ar/georef/api/ubicacion";

/** Cada cuánto se re-sincroniza el feed del SMN si alguien pide alertas. */
const ALERTS_MAX_AGE_MS = 15 * 60 * 1000;
const FORECAST_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const CAP_CONCURRENCY = 10;

/** Solo se reescribe la ubicación si se movió más de esto o pasó este tiempo. */
const LOCATION_MIN_KM = 1;
const LOCATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const alertsCol = () => adminDb().collection("weatherAlerts");
const metaDoc = () => adminDb().collection("weatherMeta").doc("smn");
const locationsCol = () => adminDb().collection("userLocations");

const get = async (url: string, accept: string) => {
  const res = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "LaLibreta/1.0 (avisos del clima)" },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res;
};

// ---------------------------------------------------------------------------
// XML (el CAP del SMN es chico y regular: alcanza con expresiones regulares)

const decodeEntities = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : null;
};

const allTags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) =>
    decodeEntities(m[1]).trim(),
  );

/** Los links a los XML CAP del RSS del SMN. */
export const parseFeedLinks = (rss: string): string[] => {
  const items = rss.split(/<item>/).slice(1);
  const links = items
    .map((item) => tag(item, "guid") ?? tag(item, "link"))
    .filter((l): l is string => !!l && l.startsWith("https://"));
  return [...new Set(links)];
};

/** Un XML CAP → aviso. Puede traer varias áreas: se queda con cada polígono por separado. */
export const parseCap = (xml: string): WeatherAlert[] => {
  const status = tag(xml, "status");
  const msgType = tag(xml, "msgType");
  if (status !== "Actual" || msgType === "Cancel") return [];
  const identifier = tag(xml, "identifier") ?? "";
  const out: WeatherAlert[] = [];
  for (const info of allTags(xml, "info")) {
    const severity = toSeverity(tag(info, "severity"));
    const onset = tag(info, "onset") ?? tag(xml, "sent") ?? "";
    const expires = tag(info, "expires") ?? "";
    if (!onset || !expires) continue;
    const base = {
      event: tag(info, "event") ?? tag(info, "headline") ?? "Alerta",
      severity,
      level: levelFor(severity),
      onset,
      expires,
      description: tag(info, "description") ?? "",
      instructions: splitInstructions(tag(info, "instruction") ?? ""),
    };
    allTags(info, "polygon").forEach((p, i) => {
      const polygon = parseCapPolygon(p);
      if (polygon.length >= 3) out.push({ ...base, id: `${identifier}#${i}`, polygon });
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Alertas del SMN

interface StoredAlert extends Omit<WeatherAlert, "polygon"> {
  guid: string;
  /** Firestore no acepta arrays anidados: "lat,lon lat,lon …". */
  polygon: string;
}

const docIdFor = (guid: string, i: number) =>
  `${createHash("sha1").update(guid).digest("hex").slice(0, 24)}-${i}`;

const fromStored = (s: StoredAlert): WeatherAlert => ({
  id: s.id,
  event: s.event,
  severity: s.severity,
  level: s.level,
  onset: s.onset,
  expires: s.expires,
  description: s.description,
  instructions: s.instructions ?? [],
  polygon: parseCapPolygon(s.polygon),
});

const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

let memo: { at: number; alerts: WeatherAlert[] } | null = null;

const readStoredAlerts = async () => {
  const snap = await alertsCol().get();
  return snap.docs.map((d) => ({ ref: d.ref, data: d.data() as StoredAlert }));
};

export interface AlertsSyncResult {
  inFeed: number;
  fetched: number;
  removed: number;
  active: number;
}

/**
 * Trae el feed del SMN, baja los avisos nuevos y borra los que ya no están.
 * Si el SMN no responde, se queda con lo que había guardado.
 */
export const syncSmnAlerts = async (): Promise<{ alerts: WeatherAlert[]; result: AlertsSyncResult }> => {
  const stored = await readStoredAlerts();
  let links: string[];
  try {
    links = parseFeedLinks(await (await get(SMN_FEED, "application/rss+xml, application/xml")).text());
  } catch (err) {
    console.warn("[weather] no se pudo leer el feed del SMN", err instanceof Error ? err.message : err);
    const alerts = stored.map((s) => fromStored(s.data)).filter((a) => isActive(a));
    return { alerts, result: { inFeed: -1, fetched: 0, removed: 0, active: alerts.length } };
  }

  const inFeed = new Set(links);
  const known = new Set(stored.map((s) => s.data.guid));
  const fresh = links.filter((l) => !known.has(l));

  const parsed = await mapLimit(fresh, CAP_CONCURRENCY, async (guid) => {
    try {
      return { guid, alerts: parseCap(await (await get(guid, "application/xml")).text()) };
    } catch (err) {
      console.warn("[weather] no se pudo bajar un aviso del SMN", guid, err instanceof Error ? err.message : err);
      return { guid, alerts: [] as WeatherAlert[] };
    }
  });

  const db = adminDb();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };
  const queue = async (fn: (b: WriteBatch) => void) => {
    fn(batch);
    if (++ops >= 400) await flush();
  };

  const newAlerts: WeatherAlert[] = [];
  for (const { guid, alerts } of parsed) {
    for (const [i, a] of alerts.entries()) {
      newAlerts.push(a);
      const doc: StoredAlert = { ...summarizeAlert(a), guid, polygon: serializePolygon(a.polygon) };
      await queue((b) => b.set(alertsCol().doc(docIdFor(guid, i)), doc));
    }
  }
  let removed = 0;
  for (const s of stored) {
    if (inFeed.has(s.data.guid) && isActive(s.data)) continue;
    removed++;
    await queue((b) => b.delete(s.ref));
  }
  await queue((b) => b.set(metaDoc(), { syncedAt: Date.now(), inFeed: links.length }));
  await flush();

  const kept = stored.filter((s) => inFeed.has(s.data.guid)).map((s) => fromStored(s.data));
  const alerts = [...kept, ...newAlerts].filter((a) => isActive(a));
  memo = { at: Date.now(), alerts };
  return { alerts, result: { inFeed: links.length, fetched: fresh.length, removed, active: alerts.length } };
};

/** Avisos vigentes del SMN (de todo el país). Re-sincroniza si pasaron más de 15 min. */
export const getActiveAlerts = async (): Promise<WeatherAlert[]> => {
  if (memo && Date.now() - memo.at < ALERTS_MAX_AGE_MS) return memo.alerts.filter((a) => isActive(a));
  const meta = await metaDoc().get();
  const syncedAt = (meta.data()?.syncedAt as number | undefined) ?? 0;
  if (Date.now() - syncedAt < ALERTS_MAX_AGE_MS) {
    const alerts = (await readStoredAlerts()).map((s) => fromStored(s.data)).filter((a) => isActive(a));
    memo = { at: syncedAt, alerts };
    return alerts;
  }
  return (await syncSmnAlerts()).alerts;
};

export const tryGetActiveAlerts = async (): Promise<WeatherAlert[]> => {
  try {
    return await getActiveAlerts();
  } catch (err) {
    console.warn("[weather] no se pudieron obtener las alertas", err);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Pronóstico (Open-Meteo)

const forecastCache = new Map<string, { at: number; value: Forecast }>();

interface OpenMeteoResponse {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    weather_code: number;
    is_day: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    relative_humidity_2m: number;
  };
  hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[]; weather_code: number[] };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    precipitation_sum: (number | null)[];
    wind_gusts_10m_max: number[];
    uv_index_max: (number | null)[];
  };
}

export const getForecast = async (lat: number, lon: number): Promise<Forecast> => {
  const key = `${coarse(lat)},${coarse(lon)}`;
  const hit = forecastCache.get(key);
  if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.value;

  const params = new URLSearchParams({
    latitude: String(coarse(lat)),
    longitude: String(coarse(lon)),
    current:
      "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,wind_gusts_10m,relative_humidity_2m",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max,uv_index_max",
    timezone: APP_TIMEZONE,
    forecast_days: "4",
    forecast_hours: "24",
  });
  const json = (await (await get(`${OPEN_METEO}?${params}`, "application/json")).json()) as OpenMeteoResponse;
  const c = json.current;
  const h = json.hourly;
  const d = json.daily;
  const value: Forecast = {
    current: {
      time: c.time,
      temperature: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      weatherCode: c.weather_code,
      isDay: c.is_day === 1,
      windSpeed: c.wind_speed_10m,
      windGusts: c.wind_gusts_10m,
      humidity: c.relative_humidity_2m,
    },
    hourly: h.time.map((time, i) => ({
      time,
      temperature: h.temperature_2m[i],
      precipProbability: h.precipitation_probability[i] ?? 0,
      weatherCode: h.weather_code[i],
    })),
    daily: d.time.map((date, i) => ({
      date,
      weatherCode: d.weather_code[i],
      tempMax: d.temperature_2m_max[i],
      tempMin: d.temperature_2m_min[i],
      precipProbability: d.precipitation_probability_max[i] ?? 0,
      precipSum: d.precipitation_sum[i] ?? 0,
      windGustsMax: d.wind_gusts_10m_max[i],
      uvIndexMax: d.uv_index_max[i] ?? 0,
    })),
  };
  forecastCache.set(key, { at: Date.now(), value });
  return value;
};

export const tryGetForecast = async (lat: number, lon: number): Promise<Forecast | null> => {
  try {
    return await getForecast(lat, lon);
  } catch (err) {
    console.warn("[weather] no se pudo obtener el pronóstico", err instanceof Error ? err.message : err);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Lugares

/** Coordenadas → municipio y provincia (Georef). Fuera de Argentina devuelve nulls. */
export const placeFor = async (lat: number, lon: number): Promise<{ place: string | null; province: string | null }> => {
  try {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    const json = (await (await get(`${GEOREF}?${params}`, "application/json")).json()) as {
      ubicacion?: {
        municipio?: { nombre?: string | null };
        departamento?: { nombre?: string | null };
        provincia?: { nombre?: string | null };
      };
    };
    const u = json.ubicacion;
    return {
      place: u?.municipio?.nombre ?? u?.departamento?.nombre ?? null,
      province: u?.provincia?.nombre ?? null,
    };
  } catch (err) {
    console.warn("[weather] georef falló", err instanceof Error ? err.message : err);
    return { place: null, province: null };
  }
};

/** Nombre de un lugar → coordenadas (para "¿cómo está el clima en Bariloche?"). */
export const geocodePlace = async (
  name: string,
): Promise<{ lat: number; lon: number; place: string; province: string | null; country: string | null } | null> => {
  const params = new URLSearchParams({ name, count: "5", language: "es", format: "json" });
  const json = (await (await get(`${OPEN_METEO_GEOCODING}?${params}`, "application/json")).json()) as {
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country?: string; country_code?: string }>;
  };
  const results = json.results ?? [];
  // Si hay un homónimo en Argentina, se prefiere ese.
  const r = results.find((x) => x.country_code === "AR") ?? results[0];
  if (!r) return null;
  return { lat: r.latitude, lon: r.longitude, place: r.name, province: r.admin1 ?? null, country: r.country ?? null };
};

// ---------------------------------------------------------------------------
// Ubicación de cada usuario

/**
 * `userLocations/{uid}` guarda la ubicación o, si el usuario pidió dejar de
 * usarla, `{ optOut: true }`: así la actualización automática al abrir la
 * app no la vuelve a guardar (en ningún dispositivo).
 */
type StoredLocation = UserLocation | { optOut: true; updatedAt: number };

const isLocation = (d: unknown): d is UserLocation =>
  !!d && typeof (d as UserLocation).lat === "number" && typeof (d as UserLocation).lon === "number";

export const getLocationState = async (uid: string): Promise<{ location: UserLocation | null; optOut: boolean }> => {
  const data = (await locationsCol().doc(uid).get()).data() as StoredLocation | undefined;
  return { location: isLocation(data) ? data : null, optOut: !!data && "optOut" in data && data.optOut === true };
};

export const getUserLocation = async (uid: string): Promise<UserLocation | null> =>
  (await getLocationState(uid)).location;

export const listUserLocations = async (): Promise<Array<{ uid: string; location: UserLocation }>> => {
  const snap = await locationsCol().get();
  return snap.docs.flatMap((d) => {
    const data = d.data();
    return isLocation(data) ? [{ uid: d.id, location: data }] : [];
  });
};

/**
 * Guarda la ubicación (redondeada a ~1 km). Si no cambió casi nada y es
 * reciente, no escribe. `explicit`: la pidió el usuario (botón "Activar",
 * ubicación por WhatsApp); sin eso, si había pedido no usarla, no se guarda.
 */
export const saveUserLocation = async (
  uid: string,
  lat: number,
  lon: number,
  source: UserLocation["source"],
  { explicit = true }: { explicit?: boolean } = {},
): Promise<{ location: UserLocation | null; changed: boolean; optOut: boolean }> => {
  const { location: prev, optOut } = await getLocationState(uid);
  if (optOut && !explicit) return { location: null, changed: false, optOut: true };
  const point = { lat: coarse(lat), lon: coarse(lon) };
  if (prev && distanceKm(prev, point) < LOCATION_MIN_KM && Date.now() - prev.updatedAt < LOCATION_MAX_AGE_MS) {
    return { location: prev, changed: false, optOut: false };
  }
  const moved = !prev || distanceKm(prev, point) >= LOCATION_MIN_KM;
  const names = moved ? await placeFor(point.lat, point.lon) : { place: prev.place, province: prev.province };
  const location: UserLocation = { ...point, ...names, source, updatedAt: Date.now() };
  await locationsCol().doc(uid).set(location);
  return { location, changed: moved, optOut: false };
};

/** "Dejar de usar mi ubicación": borra las coordenadas y recuerda que no la quiere. */
export const optOutUserLocation = async (uid: string) => {
  const doc: StoredLocation = { optOut: true, updatedAt: Date.now() };
  await locationsCol().doc(uid).set(doc);
};

// ---------------------------------------------------------------------------

/** Pronóstico + alertas vigentes para una ubicación. */
export const weatherReportFor = async (
  location: Pick<UserLocation, "lat" | "lon" | "place" | "province" | "updatedAt">,
): Promise<WeatherReport> => {
  const [forecast, alerts] = await Promise.all([
    tryGetForecast(location.lat, location.lon),
    tryGetActiveAlerts(),
  ]);
  return {
    location: { place: location.place, province: location.province, updatedAt: location.updatedAt },
    forecast,
    alerts: alertsAt(alerts, location.lat, location.lon).map(summarizeAlert),
  };
};
