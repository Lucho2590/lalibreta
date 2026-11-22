import { authedPost } from "@/lib/server/route";
import { PeopleError, requestConnection, requestConnectionByQuery } from "@/lib/server/connections";

export const runtime = "nodejs";

/** Mandar una solicitud de conexión a otro usuario (por email o por su número de WhatsApp en `q`). */
export const POST = authedPost<{ email?: string; q?: string }>(async (user, body) => {
  if (body.q) return requestConnectionByQuery(user, body.q);
  if (!body.email) throw new PeopleError("Falta el email");
  return requestConnection(user, body.email);
});
