import { authedPost } from "@/lib/server/route";
import { setFamilies } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Armar las familias de una vaquita. */
export const POST = authedPost<{ id: string; families: Array<{ id?: string; name: string }>; assignment: Record<string, string | null> }>(async (user, body) => {
  await setFamilies(user, body);
});
