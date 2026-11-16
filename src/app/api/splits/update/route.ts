import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { updateSplit, type ParticipantInput } from "@/lib/server/splits";
import type { SplitMode } from "@/lib/domain/people";

export const runtime = "nodejs";

/** Cambiar el reparto (lo que todavía no aceptaron). */
export const POST = authedPost<{ splitId?: string; mode?: SplitMode; participants?: ParticipantInput[] }>(
  async (user, body) => {
    if (!body.splitId || !Array.isArray(body.participants)) throw new PeopleError("Falta splitId o participants");
    await updateSplit(user, body.splitId, { mode: body.mode, participants: body.participants });
  },
);
