import { authedPost } from "@/lib/server/route";
import { deleteVaquita } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Borrar una vaquita (solo quien la creó). */
export const POST = authedPost<{ id: string }>(async (user, body) => {
  await deleteVaquita(user, body);
});
