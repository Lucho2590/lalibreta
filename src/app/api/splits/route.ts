import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { createSplit, type ParticipantInput } from "@/lib/server/splits";
import type { SplitMode } from "@/lib/domain/people";

export const runtime = "nodejs";

/** Repartir un gasto mío ya cargado. */
export const POST = authedPost<{ txId?: string; mode?: SplitMode; participants?: ParticipantInput[] }>(
  async (user, body) => {
    if (!body.txId || !Array.isArray(body.participants)) throw new PeopleError("Falta txId o participants");
    const id = await createSplit(user, {
      txId: body.txId,
      mode: body.mode === "lump" ? "lump" : "installments",
      participants: body.participants,
    });
    return { id };
  },
);
