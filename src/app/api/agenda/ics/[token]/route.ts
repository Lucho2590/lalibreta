import { NextResponse } from "next/server";
import { buildSingleEventCalendar, buildUserCalendar, uidForFeedToken } from "@/lib/server/calendar-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Calendario .ics de la agenda (para suscribirse desde Google Calendar,
 * iPhone u Outlook). Sin login: el token privado del link es la llave.
 * `?event=<id>`: solo esa actividad (para "Agregar al calendario").
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: raw } = await ctx.params;
  const token = raw.replace(/\.ics$/i, "");
  const uid = await uidForFeedToken(token);
  if (!uid) return new NextResponse("Calendario no encontrado", { status: 404 });

  const url = new URL(req.url);
  const appUrl = url.origin;
  const eventId = url.searchParams.get("event");
  try {
    const body = eventId ? await buildSingleEventCalendar(uid, eventId, appUrl) : await buildUserCalendar(uid, appUrl);
    if (!body) return new NextResponse("Actividad no encontrada", { status: 404 });
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `${eventId ? "attachment" : "inline"}; filename="${eventId ? "actividad" : "la-libreta"}.ics"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    console.error("[agenda] ics", err);
    return new NextResponse("No se pudo armar el calendario", { status: 500 });
  }
}
