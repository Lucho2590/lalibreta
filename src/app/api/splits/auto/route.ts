import { authedPost } from "@/lib/server/route";
import { applySplitRules } from "@/lib/server/split-rules";

export const runtime = "nodejs";

/** Gastos recién cargados desde la app: si alguno se divide siempre, se divide. */
export const POST = authedPost<{ txIds?: string[] }>(async (user, body) => {
  const txIds = Array.isArray(body.txIds) ? body.txIds.filter((x) => typeof x === "string").slice(0, 50) : [];
  const applied = await applySplitRules(user.uid, txIds);
  return { applied: applied.map(({ label, names }) => ({ label, names })) };
});
