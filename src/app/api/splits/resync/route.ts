import { authedPost } from "@/lib/server/route";
import { resyncSplitsForTx } from "@/lib/server/splits";

export const runtime = "nodejs";

/** Las cuotas de unos gastos míos cambiaron: rehacer sus repartos. */
export const POST = authedPost<{ txIds?: string[] }>(async (user, body) => {
  const txIds = Array.isArray(body.txIds) ? body.txIds.filter((x) => typeof x === "string").slice(0, 500) : [];
  return { resynced: await resyncSplitsForTx(user.uid, txIds) };
});
