import type { CalendarEvent } from "./ical";
import { participantName, type Activity } from "./activity-model";

/** Una actividad → evento de calendario (con quién va y las notas en la descripción). */
export const activityToEvent = (a: Activity, uid: string, appUrl: string): CalendarEvent => {
  const others = a.participants
    .filter((p) => p.uid !== uid && (p.status === "owner" || p.status === "accepted"))
    .map((p) => p.displayName || participantName(p));
  const description = [others.length ? `Con ${others.join(", ")}` : null, a.notes || null]
    .filter(Boolean)
    .join("\n\n");
  const updated = a.updatedAt ?? a.createdAt;
  return {
    id: a.id,
    title: a.title,
    date: a.date,
    time: a.time,
    location: a.location,
    description: description || null,
    url: `${appUrl}/agenda?month=${a.date.slice(0, 7)}`,
    updatedAt: updated && typeof updated.toMillis === "function" ? updated.toMillis() : undefined,
  };
};
