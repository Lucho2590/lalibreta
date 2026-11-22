import { authedPost } from "@/lib/server/route";
import { PeopleError, connectionState, findUserByQuery } from "@/lib/server/connections";
import { parseContactQuery } from "@/lib/domain/phone";
import { profileName } from "@/lib/domain/people";

export const runtime = "nodejs";

/**
 * ¿Esta persona usa La Libreta? Por email (el de su cuenta) o por su número
 * de WhatsApp (el que vinculó con el bot). Devuelve su nombre y foto, y cómo
 * estoy con ella (conectados, solicitud pendiente…), pero nunca su uid ni su
 * email si la buscaron por teléfono.
 */
export const POST = authedPost<{ q?: string }>(async (user, body) => {
  const q = parseContactQuery(body.q ?? "");
  if (!q) throw new PeopleError("Escribí su email o su número de WhatsApp (con característica)");
  const found = await findUserByQuery(q);
  if (!found) return { kind: q.kind, value: q.value, found: false };
  const { state } = await connectionState(user.uid, found.uid);
  return {
    kind: q.kind,
    value: q.value,
    found: true,
    name: profileName(found.profile),
    photoURL: found.profile.photoURL,
    state,
  };
});
