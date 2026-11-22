import { authedPost } from "@/lib/server/route";
import { addMembers, type MemberInput } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Sumar gente a una vaquita. */
export const POST = authedPost<{ id: string; members: MemberInput[] }>(async (user, body) => {
  await addMembers(user, body);
});
