import { authedPost } from "@/lib/server/route";
import { renameMember } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Cambiar el nombre de alguien sin la app. */
export const POST = authedPost<{ id: string; memberId: string; name: string }>(async (user, body) => {
  await renameMember(user, body);
});
