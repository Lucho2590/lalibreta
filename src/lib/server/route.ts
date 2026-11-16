import "server-only";

import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse, type AuthedUser } from "./auth";
import { PeopleError } from "./connections";

/**
 * POST autenticado con body JSON: (user, body) → respuesta. Los PeopleError
 * vuelven como { error } con su status.
 */
export const authedPost =
  <B>(handler: (user: AuthedUser, body: B) => Promise<unknown>) =>
  async (req: Request) => {
    let user: AuthedUser;
    try {
      user = await getAuthedUser(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
      throw err;
    }
    const body = (await req.json().catch(() => null)) as B | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Falta el body" }, { status: 400 });
    try {
      const result = await handler(user, body);
      return NextResponse.json({ ok: true, ...(result && typeof result === "object" ? result : {}) });
    } catch (err) {
      if (err instanceof PeopleError) return NextResponse.json({ error: err.message }, { status: err.status });
      console.error("[api]", err);
      return NextResponse.json({ error: "No se pudo completar" }, { status: 500 });
    }
  };
