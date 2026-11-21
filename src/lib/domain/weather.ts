/**
 * Clima: tipos y lógica pura (sin red). Lo usan el server (avisos, agente)
 * y la app (tarjeta del inicio, /clima).
 *
 * Fuentes:
 * - Alertas: SMN (feed CAP oficial). Licencia CC BY 4.0 → citar "Fuente: SMN".
 * - Pronóstico: Open-Meteo.
 */

export type AlertSeverity = "Minor" | "Moderate" | "Severe" | "Extreme" | "Unknown";
export type AlertLevel = "amarilla" | "naranja" | "roja";

export interface WeatherAlert {
  /** Identificador CAP del aviso (cambia cada vez que el SMN lo actualiza). */
  id: string;
  /** "Tormentas", "Nevadas", "Lluvias", "Viento", "Calor extremo"… */
  event: string;
  severity: AlertSeverity;
  level: AlertLevel;
  /** ISO 8601 con offset. */
  onset: string;
  expires: string;
  description: string;
  /** Recomendaciones del SMN, ya separadas en pasos. */
  instructions: string[];
  /** Polígono del área: [lat, lon][]. */
  polygon: Array<[number, number]>;
}

/** Lo que se le manda a la app / al agente (sin el polígono). */
export type WeatherAlertSummary = Omit<WeatherAlert, "polygon">;

export interface CurrentWeather {
  time: string;
  temperature: number;
  feelsLike: number;
  weatherCode: number;
  isDay: boolean;
  windSpeed: number;
  windGusts: number;
  humidity: number;
}

export interface DailyWeather {
  /** YYYY-MM-DD */
  date: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  /** % máximo de probabilidad de lluvia en el día. */
  precipProbability: number;
  /** mm acumulados. */
  precipSum: number;
  windGustsMax: number;
  uvIndexMax: number;
}

export interface HourlyWeather {
  /** YYYY-MM-DDTHH:mm (hora argentina). */
  time: string;
  temperature: number;
  precipProbability: number;
  weatherCode: number;
}

export interface Forecast {
  current: CurrentWeather;
  /** Próximas 24 h. */
  hourly: HourlyWeather[];
  /** Hoy y los próximos días. */
  daily: DailyWeather[];
}

export interface UserLocation {
  lat: number;
  lon: number;
  /** "General Pueyrredón" */
  place: string | null;
  /** "Buenos Aires" */
  province: string | null;
  source: "gps" | "whatsapp";
  /** ms epoch */
  updatedAt: number;
}

export interface WeatherReport {
  location: Pick<UserLocation, "place" | "province" | "updatedAt">;
  forecast: Forecast | null;
  alerts: WeatherAlertSummary[];
}

// ---------------------------------------------------------------------------
// Alertas

export const levelFor = (severity: AlertSeverity): AlertLevel =>
  severity === "Extreme" ? "roja" : severity === "Severe" ? "naranja" : "amarilla";

const LEVEL_RANK: Record<AlertLevel, number> = { amarilla: 1, naranja: 2, roja: 3 };

export const levelRank = (level: AlertLevel) => LEVEL_RANK[level];

export const LEVEL_EMOJI: Record<AlertLevel, string> = { amarilla: "🟡", naranja: "🟠", roja: "🔴" };

export const toSeverity = (s: string | null | undefined): AlertSeverity =>
  s === "Minor" || s === "Moderate" || s === "Severe" || s === "Extreme" ? s : "Unknown";

/**
 * ¿El punto está dentro del polígono? (ray casting). Los polígonos del SMN
 * cubren zonas de cientos de km, así que tratar lat/lon como plano alcanza.
 */
export const pointInPolygon = (lat: number, lon: number, polygon: ReadonlyArray<readonly [number, number]>): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lonI] = polygon[i];
    const [latJ, lonJ] = polygon[j];
    const crosses = lonI > lon !== lonJ > lon && lat < ((latJ - latI) * (lon - lonI)) / (lonJ - lonI) + latI;
    if (crosses) inside = !inside;
  }
  return inside;
};

/** "-33.94,-62.54 -33.96,-62.56 …" (formato CAP) → [[lat, lon], …]. */
export const parseCapPolygon = (text: string): Array<[number, number]> =>
  text
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number) as [number, number])
    .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));

export const serializePolygon = (polygon: ReadonlyArray<readonly [number, number]>) =>
  polygon.map(([lat, lon]) => `${lat},${lon}`).join(" ");

/** "1- Evitá salir. 2- No saques la basura…" → ["Evitá salir.", "No saques la basura…"]. */
export const splitInstructions = (text: string): string[] =>
  text
    .split(/(?:^|\s)\d{1,2}\s*[-.)]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const isActive = (alert: Pick<WeatherAlert, "expires">, now = Date.now()) =>
  Date.parse(alert.expires) > now;

/**
 * Las alertas vigentes que tocan un punto, la más grave primero. Si el SMN
 * publica varias del mismo fenómeno (una por tramo horario), quedan todas:
 * la app las muestra ordenadas por inicio.
 */
export const alertsAt = (
  alerts: readonly WeatherAlert[],
  lat: number,
  lon: number,
  now = Date.now(),
): WeatherAlert[] => {
  // El SMN a veces publica el mismo aviso en zonas que se superponen: se muestra una vez.
  const seen = new Set<string>();
  return alerts
    .filter((a) => isActive(a, now) && pointInPolygon(lat, lon, a.polygon))
    .filter((a) => {
      const key = `${a.event}|${a.level}|${a.onset.slice(0, 16)}|${a.expires.slice(0, 16)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => levelRank(b.level) - levelRank(a.level) || a.onset.localeCompare(b.onset));
};

export const summarizeAlert = (a: WeatherAlert): WeatherAlertSummary => ({
  id: a.id,
  event: a.event,
  severity: a.severity,
  level: a.level,
  onset: a.onset,
  expires: a.expires,
  description: a.description,
  instructions: a.instructions,
});

/**
 * Clave para no avisar dos veces lo mismo. El SMN cambia el identificador
 * cada vez que actualiza (varias veces por día), así que se usa
 * fenómeno + nivel + día de inicio: si sube de amarilla a naranja, avisa de nuevo.
 */
export const alertDedupeKey = (alert: Pick<WeatherAlert, "event" | "level" | "onset">) => {
  const slug = alert.event
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `wx-${slug}-${alert.level}-${alert.onset.slice(0, 10)}`;
};

// ---------------------------------------------------------------------------
// Fechas (hora argentina)

const TZ = "America/Argentina/Buenos_Aires";

const hhmm = (iso: string) =>
  new Intl.DateTimeFormat("es-AR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );

const ymdAR = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const dayLabel = (iso: string, now: Date) => {
  const day = ymdAR(new Date(iso));
  const today = ymdAR(now);
  const tomorrow = ymdAR(new Date(now.getTime() + 86_400_000));
  if (day === today) return "hoy";
  if (day === tomorrow) return "mañana";
  return new Intl.DateTimeFormat("es-AR", { timeZone: TZ, weekday: "long", day: "numeric" }).format(new Date(iso));
};

/** "desde hoy 15:45 hasta las 20:59" / "desde mañana 03:00 hasta mañana 08:59". */
export const alertWindowText = (alert: Pick<WeatherAlert, "onset" | "expires">, now = new Date()) => {
  const started = Date.parse(alert.onset) <= now.getTime();
  const endDay = dayLabel(alert.expires, now);
  const until = `hasta ${endDay === "hoy" ? "las" : endDay} ${hhmm(alert.expires)}`;
  return started ? `vigente ${until}` : `desde ${dayLabel(alert.onset, now)} ${hhmm(alert.onset)} ${until}`;
};

// ---------------------------------------------------------------------------
// Códigos del tiempo (WMO, los que usa Open-Meteo)

interface CodeInfo {
  text: string;
  day: string;
  night?: string;
}

const WMO: Record<number, CodeInfo> = {
  0: { text: "Despejado", day: "☀️", night: "🌙" },
  1: { text: "Mayormente despejado", day: "🌤️", night: "🌙" },
  2: { text: "Parcialmente nublado", day: "⛅", night: "☁️" },
  3: { text: "Nublado", day: "☁️" },
  45: { text: "Niebla", day: "🌫️" },
  48: { text: "Niebla con escarcha", day: "🌫️" },
  51: { text: "Llovizna débil", day: "🌦️" },
  53: { text: "Llovizna", day: "🌦️" },
  55: { text: "Llovizna intensa", day: "🌧️" },
  56: { text: "Llovizna helada", day: "🌧️" },
  57: { text: "Llovizna helada intensa", day: "🌧️" },
  61: { text: "Lluvia débil", day: "🌦️" },
  63: { text: "Lluvia", day: "🌧️" },
  65: { text: "Lluvia fuerte", day: "🌧️" },
  66: { text: "Lluvia helada", day: "🌧️" },
  67: { text: "Lluvia helada fuerte", day: "🌧️" },
  71: { text: "Nevada débil", day: "🌨️" },
  73: { text: "Nevada", day: "🌨️" },
  75: { text: "Nevada fuerte", day: "❄️" },
  77: { text: "Granizo fino", day: "🌨️" },
  80: { text: "Chaparrones", day: "🌦️" },
  81: { text: "Chaparrones fuertes", day: "🌧️" },
  82: { text: "Chaparrones muy fuertes", day: "⛈️" },
  85: { text: "Nevadas aisladas", day: "🌨️" },
  86: { text: "Nevadas aisladas fuertes", day: "❄️" },
  95: { text: "Tormenta", day: "⛈️" },
  96: { text: "Tormenta con granizo", day: "⛈️" },
  99: { text: "Tormenta fuerte con granizo", day: "⛈️" },
};

export const weatherText = (code: number) => WMO[code]?.text ?? "—";

export const weatherEmoji = (code: number, isDay = true) => {
  const info = WMO[code];
  if (!info) return "🌡️";
  return isDay ? info.day : (info.night ?? info.day);
};

const round = (n: number) => Math.round(n);

/**
 * Resumen corto del día para el aviso de la mañana:
 * "18° a 28° · Parcialmente nublado · 70 % de lluvia (12 mm)".
 */
export const dailySummaryText = (day: DailyWeather) => {
  const parts = [`${round(day.tempMin)}° a ${round(day.tempMax)}°`, weatherText(day.weatherCode)];
  if (day.precipProbability >= 30) {
    const mm = day.precipSum >= 1 ? ` (${round(day.precipSum)} mm)` : "";
    parts.push(`${day.precipProbability} % de lluvia${mm}`);
  }
  if (day.windGustsMax >= 60) parts.push(`ráfagas de ${round(day.windGustsMax)} km/h`);
  if (day.uvIndexMax >= 8) parts.push(`UV muy alto (${round(day.uvIndexMax)})`);
  return parts.join(" · ");
};

/**
 * Las horas del resto del día con más chance de lluvia, para decir
 * "lluvia a la tarde". Devuelve null si no hay ninguna ≥ 50 %.
 */
export const rainWindowText = (hourly: readonly HourlyWeather[], date: string): string | null => {
  const rainy = hourly.filter((h) => h.time.startsWith(date) && h.precipProbability >= 50);
  if (rainy.length === 0) return null;
  const part = (h: HourlyWeather) => {
    const hour = Number(h.time.slice(11, 13));
    return hour < 6 ? "la madrugada" : hour < 12 ? "la mañana" : hour < 19 ? "la tarde" : "la noche";
  };
  const parts = [...new Set(rainy.map(part))];
  return `Lluvia probable a ${parts.join(" y a ")}`;
};

/** Distancia aproximada en km (equirectangular, alcanza para "se movió más de 1 km"). */
export const distanceKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371;
};

/** Redondea a 2 decimales (~1 km): no guardamos la ubicación exacta. */
export const coarse = (n: number) => Math.round(n * 100) / 100;

export const placeText = (loc: Pick<UserLocation, "place" | "province">) =>
  [loc.place, loc.province].filter(Boolean).join(", ") || "tu zona";
