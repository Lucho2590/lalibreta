import type { PersonRef } from "@/lib/domain/people";
import { PeopleError } from "@/lib/server/connections";
import { authedPost } from "@/lib/server/route";
import { linkMember, linkMemberByQuery } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/**
 * Vincular a alguien "sin la app" con su cuenta: con `ref` (un contacto) ya;
 * con `q` (su WhatsApp o email) le manda la solicitud o lo invita y se
 * vincula solo después.
 */
export const POST = authedPost<{ id: string; memberId: string; ref?: PersonRef; q?: string }>(async (user, body) => {
  if (body.q && !body.ref) return await linkMemberByQuery(user, { id: body.id, memberId: body.memberId, q: body.q });
  if (!body.ref) throw new PeopleError("Elegí a quién");
  const r = await linkMember(user, { id: body.id, memberId: body.memberId, ref: body.ref });
  return { status: "linked" as const, name: r.name };
});
