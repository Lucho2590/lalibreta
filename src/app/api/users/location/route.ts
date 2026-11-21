import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse, type AuthedUser } from "@/lib/server/auth";
import { getLocationState, optOutUserLocation, saveUserLocation } from "@/lib/server/weather";
import type { UserLocation } from "@/lib/domain/weather";

export const runtime = "nodejs";

/**
 * Ubicación del usuario para el clima (GPS del teléfono, redondeada a ~1 km).
 * GET: la guardada (o null) y si pidió no usarla.
 * POST { lat, lon, explicit? }: la actualiza. Sin `explicit` (la actualización
 *   automática al abrir la app) no hace nada si el usuario pidió no usarla.
 * DELETE: "dejar de usar mi ubicación".
 */

const withUser = async (req: Request, fn: (user: AuthedUser) => Promise<Response>) => {
  try {
    return await fn(await getAuthedUser(req));
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    console.error("[api] ubicación", err);
    return NextResponse.json({ error: "No se pudo completar" }, { status: 500 });
  }
};

const publicView = (loc: UserLocation | null) =>
  loc ? { place: loc.place, province: loc.province, source: loc.source, updatedAt: loc.updatedAt } : null;

export const GET = (req: Request) =>
  withUser(req, async (user) => {
    const { location, optOut } = await getLocationState(user.uid);
    return NextResponse.json({ location: publicView(location), optOut });
  });

export const POST = (req: Request) =>
  withUser(req, async (user) => {
    const body = (await req.json().catch(() => null)) as { lat?: unknown; lon?: unknown; explicit?: unknown } | null;
    const lat = Number(body?.lat);
    const lon = Number(body?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return NextResponse.json({ error: "Ubicación inválida" }, { status: 400 });
    }
    const res = await saveUserLocation(user.uid, lat, lon, "gps", { explicit: body?.explicit === true });
    return NextResponse.json({ ok: true, changed: res.changed, optOut: res.optOut, location: publicView(res.location) });
  });

export const DELETE = (req: Request) =>
  withUser(req, async (user) => {
    await optOutUserLocation(user.uid);
    return NextResponse.json({ ok: true });
  });
