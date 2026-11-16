import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { deleteSplitRule } from "@/lib/server/split-rules";

export const runtime = "nodejs";

/** Dejar de dividir siempre un comercio (lo ya dividido queda). */
export const POST = authedPost<{ id?: string }>(async (user, body) => {
  if (!body.id) throw new PeopleError("Falta id");
  await deleteSplitRule(user.uid, body.id);
});
