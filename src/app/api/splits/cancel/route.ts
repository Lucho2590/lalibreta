import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { cancelSplit } from "@/lib/server/splits";

export const runtime = "nodejs";

/** Cancelar un reparto (y opcionalmente borrar el gasto). */
export const POST = authedPost<{ splitId?: string; deleteOwnerTx?: boolean }>(async (user, body) => {
  if (!body.splitId) throw new PeopleError("Falta splitId");
  await cancelSplit(user, body.splitId, { deleteOwnerTx: !!body.deleteOwnerTx });
});
