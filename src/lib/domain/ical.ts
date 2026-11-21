/**
 * Calendarios (iCalendar / .ics y links de Google Calendar) para las
 * actividades de la agenda. Puro: lo usan el server (feed de suscripción) y
 * la app (botón "Agregar a Google Calendar").
 *
 * Las horas de la agenda son de Argentina (UTC−3, sin horario de verano): se
 * pasan a UTC para que cualquier calendario las muestre bien.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  /** "YYYY-MM-DD" (Argentina). */
  date: string;
  /** "HH:mm" o null/undefined si es todo el día. */
  time?: string | null;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  /** ms epoch: última modificación (DTSTAMP). */
  updatedAt?: number;
}

/** Duración que se asume para las que tienen hora (la agenda no guarda fin). */
const DEFAULT_DURATION_MIN = 60;
const AR_OFFSET_HOURS = 3;

const pad = (n: number) => String(n).padStart(2, "0");

/** Date (UTC) → "YYYYMMDDTHHMMSSZ". */
const utcStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** "YYYY-MM-DD" → "YYYYMMDD". */
const compactDate = (ymd: string) => ymd.replace(/-/g, "");

const nextDay = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
};

/** Inicio y fin en UTC de una actividad con hora. */
const timedRange = (date: string, time: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, hh + AR_OFFSET_HOURS, mm));
  const end = new Date(start.getTime() + DEFAULT_DURATION_MIN * 60_000);
  return { start, end };
};

const isTime = (t: string | null | undefined): t is string => !!t && /^\d{2}:\d{2}$/.test(t);

// ---------------------------------------------------------------------------
// iCalendar

/** Escapa texto según RFC 5545 (\\ ; , y saltos de línea). */
const escapeText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Corta líneas largas en 75 octetos (continuación con un espacio), sin partir caracteres. */
const fold = (line: string) => {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // las continuaciones llevan un espacio adelante
    if (bytes + b > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += b;
  }
  out.push(current);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join("\r\n");
};

const eventLines = (e: CalendarEvent, domain: string, now: Date): string[] => {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.id}@${domain}`,
    `DTSTAMP:${utcStamp(e.updatedAt ? new Date(e.updatedAt) : now)}`,
  ];
  if (isTime(e.time)) {
    const { start, end } = timedRange(e.date, e.time);
    lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(e.date)}`, `DTEND;VALUE=DATE:${compactDate(nextDay(e.date))}`);
  }
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  lines.push("END:VEVENT");
  return lines;
};

/** Un calendario .ics con las actividades dadas. */
export const buildICalendar = (
  events: CalendarEvent[],
  opts: { name: string; domain: string; now?: Date },
): string => {
  const now = opts.now ?? new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//La Libreta//Agenda//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    "X-WR-TIMEZONE:America/Argentina/Buenos_Aires",
    // Sugerencia de cada cuánto actualizar (el iPhone y Outlook la usan; Google decide solo).
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...events.flatMap((e) => eventLines(e, opts.domain, now)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
};

// ---------------------------------------------------------------------------
// Google Calendar

/** Link que abre Google Calendar con el evento listo para guardar. */
export const googleCalendarEventUrl = (e: CalendarEvent): string => {
  const dates = isTime(e.time)
    ? (() => {
        const { start, end } = timedRange(e.date, e.time);
        return `${utcStamp(start)}/${utcStamp(end)}`;
      })()
    : `${compactDate(e.date)}/${compactDate(nextDay(e.date))}`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, ctz: "America/Argentina/Buenos_Aires" });
  if (e.location) params.set("location", e.location);
  const details = [e.description, e.url].filter(Boolean).join("\n\n");
  if (details) params.set("details", details);
  return `https://calendar.google.com/calendar/render?${params}`;
};

/** Link que agrega una suscripción (URL .ics) a Google Calendar. */
export const googleCalendarSubscribeUrl = (icsUrl: string): string =>
  `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(icsUrl.replace(/^https?:\/\//, "webcal://"))}`;

/** La misma URL con webcal:// (el iPhone y la Mac abren "Suscribirse"). */
export const webcalUrl = (icsUrl: string): string => icsUrl.replace(/^https?:\/\//, "webcal://");
