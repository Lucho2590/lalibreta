import { authedPost } from "@/lib/server/route";
import { PeopleError, removeConnection } from "@/lib/server/connections";

export const runtime = "nodejs";

/** Cancelar una solicitud enviada o desconectarse. */
export const POST = authedPost<{ id?: string }>(async (user, body) => {
  if (!body.id) throw new PeopleError("Falta id");
  await removeConnection(user, body.id);
});
