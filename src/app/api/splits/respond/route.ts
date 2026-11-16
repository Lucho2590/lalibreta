import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { respondSplit } from "@/lib/server/splits";

export const runtime = "nodejs";

/** Aceptar (y elegir si lo sumo a mis gastos) o rechazar mi parte. */
export const POST = authedPost<{
  splitId?: string;
  accept?: boolean;
  addToBooks?: boolean;
  categoryId?: string | null;
  reason?: string | null;
  always?: boolean;
}>(async (user, body) => {
  if (!body.splitId || typeof body.accept !== "boolean") throw new PeopleError("Falta splitId o accept");
  await respondSplit(user, body.splitId, {
    accept: body.accept,
    addToBooks: !!body.addToBooks,
    categoryId: body.categoryId ?? null,
    reason: body.reason ?? null,
    always: !!body.always,
  });
});
