import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { setSplitBooks } from "@/lib/server/splits";

export const runtime = "nodejs";

/** Sumar o sacar mi parte de mis gastos (después de aceptarla). */
export const POST = authedPost<{ splitId?: string; addToBooks?: boolean; categoryId?: string | null }>(
  async (user, body) => {
    if (!body.splitId || typeof body.addToBooks !== "boolean") throw new PeopleError("Falta splitId o addToBooks");
    await setSplitBooks(user, body.splitId, { addToBooks: body.addToBooks, categoryId: body.categoryId ?? null });
  },
);
