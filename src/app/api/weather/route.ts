import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { getLocationState, weatherReportFor } from "@/lib/server/weather";

export const runtime = "nodejs";

/** Clima y alertas del SMN en la ubicación guardada del usuario. */
export async function GET(req: Request) {
  try {
    const user = await getAuthedUser(req);
    const { location, optOut } = await getLocationState(user.uid);
    if (!location) return NextResponse.json({ location: null, forecast: null, alerts: [], optOut });
    return NextResponse.json({ ...(await weatherReportFor(location)), optOut: false });
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    console.error("[api] clima", err);
    return NextResponse.json({ error: "No se pudo obtener el clima" }, { status: 500 });
  }
}
