import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { respondPersonTransfer } from "@/lib/server/person-transfers";

export const runtime = "nodejs";

/** Confirmar (eligiendo mi cuenta) o rechazar una transferencia que registró la otra persona. */
export const POST = authedPost<{ id?: string; accept?: boolean; accountId?: string | null }>(async (user, body) => {
  if (!body.id || typeof body.accept !== "boolean") throw new PeopleError("Falta id o accept");
  await respondPersonTransfer(user, body.id, { accept: body.accept, accountId: body.accountId ?? null });
});
