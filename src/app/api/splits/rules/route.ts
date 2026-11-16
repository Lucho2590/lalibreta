import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { createSplitRule } from "@/lib/server/split-rules";
import type { ParticipantInput } from "@/lib/server/splits";
import type { SplitMode } from "@/lib/domain/people";

export const runtime = "nodejs";

/** "Dividir siempre así" los gastos del comercio de este gasto. */
export const POST = authedPost<{ txId?: string; mode?: SplitMode; participants?: ParticipantInput[] }>(
  async (user, body) => {
    if (!body.txId || !Array.isArray(body.participants)) throw new PeopleError("Falta txId o participants");
    return createSplitRule(user.uid, {
      txId: body.txId,
      mode: body.mode === "lump" ? "lump" : "installments",
      participants: body.participants,
    });
  },
);
