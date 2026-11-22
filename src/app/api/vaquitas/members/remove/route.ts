import { authedPost } from "@/lib/server/route";
import { removeMember } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Sacar a alguien (sin gastos ni pagos). */
export const POST = authedPost<{ id: string; memberId: string }>(async (user, body) => {
  await removeMember(user, body);
});
