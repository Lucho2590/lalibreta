import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { setSplitAutoAccept } from "@/lib/server/splits";

export const runtime = "nodejs";

/** Aceptar siempre (o dejar de aceptar solos) los próximos de un gasto que se divide siempre. */
export const POST = authedPost<{ splitId?: string; enabled?: boolean }>(async (user, body) => {
  if (!body.splitId || typeof body.enabled !== "boolean") throw new PeopleError("Falta splitId o enabled");
  await setSplitAutoAccept(user, body.splitId, body.enabled);
});
