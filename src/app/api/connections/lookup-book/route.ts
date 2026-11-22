import { authedPost } from "@/lib/server/route";
import { PeopleError, lookupBookContacts } from "@/lib/server/connections";
import { cleanBookContacts, MAX_BOOK_CONTACTS } from "@/lib/domain/address-book";

export const runtime = "nodejs";

/** ¿Quiénes de estos contactos de la agenda usan La Libreta? (hasta 100 por vez) */
export const POST = authedPost<{ contacts?: unknown }>(async (user, body) => {
  if (!Array.isArray(body.contacts)) throw new PeopleError("Faltan los contactos");
  if (body.contacts.length > MAX_BOOK_CONTACTS * 2) throw new PeopleError(`Elegí hasta ${MAX_BOOK_CONTACTS} contactos por vez`);
  const contacts = cleanBookContacts(
    (body.contacts as Array<Record<string, unknown>>).map((c) => ({
      name: typeof c?.name === "string" ? c.name : null,
      phones: Array.isArray(c?.phones) ? c.phones.filter((x): x is string => typeof x === "string") : [],
      emails: Array.isArray(c?.emails) ? c.emails.filter((x): x is string => typeof x === "string") : [],
    })),
  );
  return { results: await lookupBookContacts(user.uid, contacts) };
});
