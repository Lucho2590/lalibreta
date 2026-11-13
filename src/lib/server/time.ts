import "server-only";

/**
 * Helpers de fecha en hora de Argentina. En Vercel el server corre en UTC,
 * así que "hoy" y las fechas que interpreta el agente se calculan acá.
 */
export const APP_TIMEZONE = "America/Argentina/Buenos_Aires";

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" de hoy en Argentina. */
export const todayYMD = (now = new Date()): string => ymdFormatter.format(now);

/** "YYYY-MM" del mes actual en Argentina. */
export const currentMonthKey = (now = new Date()): string =>
  todayYMD(now).slice(0, 7);

export const isYMD = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isMonthKey = (s: string): boolean => /^\d{4}-\d{2}$/.test(s);

/**
 * Convierte "YYYY-MM-DD" en un Date a las 12:00 de Argentina (UTC-3, sin
 * horario de verano). Al mediodía el día calendario es el mismo tanto en
 * UTC como en hora local, así getDate()/getMonth() dan el día correcto en
 * cualquier server.
 */
export const dateFromYMD = (ymd: string): Date =>
  new Date(`${ymd}T12:00:00-03:00`);

const longDateFormatter = new Intl.DateTimeFormat("es-AR", {
  timeZone: APP_TIMEZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export const formatLongDate = (d: Date): string => longDateFormatter.format(d);

const shortDateFormatter = new Intl.DateTimeFormat("es-AR", {
  timeZone: APP_TIMEZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export const formatShortDateAR = (d: Date): string => shortDateFormatter.format(d);
