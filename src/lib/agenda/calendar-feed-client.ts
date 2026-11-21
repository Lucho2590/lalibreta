"use client";

import { apiPost } from "@/lib/api";

export interface CalendarFeed {
  token: string;
  /** https://…/api/agenda/ics/<token>.ics */
  url: string;
}

// El link no cambia salvo que se regenere: una consulta por sesión.
let cached: Promise<CalendarFeed> | null = null;

/** El link privado de la agenda (lo crea la primera vez). */
export const getCalendarFeed = () => {
  cached ??= apiPost<CalendarFeed>("/api/agenda/feed", {}).catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
};

/** Link nuevo: el anterior deja de andar en todos lados. */
export const resetCalendarFeed = async () => {
  const feed = await apiPost<CalendarFeed>("/api/agenda/feed", { reset: true });
  cached = Promise.resolve(feed);
  return feed;
};

/** URL .ics de una sola actividad (para agregarla al calendario del celular). */
export const singleEventIcsUrl = (feed: CalendarFeed, activityId: string) =>
  `${feed.url}?event=${encodeURIComponent(activityId)}`;
