import { authedPost } from "@/lib/server/route";
import { PeopleError } from "@/lib/server/connections";
import { sendEmailInvite } from "@/lib/server/invites";

export const runtime = "nodejs";

/** Mandarle un mail de invitación a alguien que no usa La Libreta. */
export const POST = authedPost<{ email?: string; name?: string }>(async (user, body) => {
  if (!body.email) throw new PeopleError("Falta el email");
  return sendEmailInvite(user, body.email, body.name);
});
