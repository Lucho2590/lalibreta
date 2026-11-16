import { authedPost } from "@/lib/server/route";
import { PeopleError, respondConnection } from "@/lib/server/connections";

export const runtime = "nodejs";

/** Aceptar o rechazar una solicitud de conexión. */
export const POST = authedPost<{ id?: string; accept?: boolean }>(async (user, body) => {
  if (!body.id || typeof body.accept !== "boolean") throw new PeopleError("Falta id o accept");
  await respondConnection(user, body.id, body.accept);
});
