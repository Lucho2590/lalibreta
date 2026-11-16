import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { cancelPersonTransfer } from "@/lib/server/person-transfers";

export const runtime = "nodejs";

/** Borrar una transferencia con una persona (de las cuentas de los dos). */
export const POST = authedPost<{ id?: string }>(async (user, body) => {
  if (!body.id) throw new PeopleError("Falta id");
  await cancelPersonTransfer(user, body.id);
});
