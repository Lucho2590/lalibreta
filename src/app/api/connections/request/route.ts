import { authedPost } from "@/lib/server/route";
import { PeopleError, requestConnection } from "@/lib/server/connections";

export const runtime = "nodejs";

/** Mandar una solicitud de conexión a otro usuario (por email). */
export const POST = authedPost<{ email?: string }>(async (user, body) => {
  if (!body.email) throw new PeopleError("Falta el email");
  return requestConnection(user, body.email);
});
