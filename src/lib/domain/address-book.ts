/**
 * Contactos traídos de la agenda del teléfono: del selector de contactos del
 * navegador (Android), de un archivo .vcf (iPhone: Contactos → Compartir) o
 * compartidos al bot por WhatsApp. Helpers puros.
 */

import { looksLikeEmail, normalizePhone } from "./phone";

export interface BookContact {
  name: string;
  /** Ya normalizados como waId (549…). */
  phones: string[];
  emails: string[];
}

export const MAX_BOOK_CONTACTS = 100;
const MAX_PER_CONTACT = 5;

/** Limpia, normaliza y saca repetidos (y los que no tienen ni teléfono ni email). */
export const cleanBookContacts = (
  list: Array<{ name?: string | null; phones?: Array<string | null | undefined>; emails?: Array<string | null | undefined> }>,
): BookContact[] => {
  const out: BookContact[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const phones = [
      ...new Set((c.phones ?? []).map((p) => (p ? normalizePhone(p) : null)).filter((p): p is string => !!p)),
    ].slice(0, MAX_PER_CONTACT);
    const emails = [
      ...new Set(
        (c.emails ?? []).map((e) => e?.trim().toLowerCase() ?? "").filter((e) => looksLikeEmail(e)),
      ),
    ].slice(0, MAX_PER_CONTACT);
    if (!phones.length && !emails.length) continue;
    const key = [...phones, ...emails].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (c.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80) || emails[0]?.split("@")[0] || phones[0];
    out.push({ name, phones, emails });
    if (out.length >= MAX_BOOK_CONTACTS) break;
  }
  return out;
};

/** Valor de una línea vCard: saca escapes (\, \; \n). */
const unescapeValue = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** Quoted-printable (vCard 2.1 de algunos Android). */
const decodeQP = (v: string) => {
  try {
    const bytes = v
      .replace(/=\r?\n/g, "")
      .split(/(=[0-9A-F]{2})/i)
      .flatMap((part) =>
        /^=[0-9A-F]{2}$/i.test(part) ? [parseInt(part.slice(1), 16)] : [...new TextEncoder().encode(part)],
      );
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return v;
  }
};

/** Lee un archivo .vcf (una o muchas tarjetas) → contactos con nombre, teléfonos y emails. */
export const parseVCards = (text: string): BookContact[] => {
  // "Unfolding": las líneas que empiezan con espacio siguen a la anterior.
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const cards: Array<{ name?: string; n?: string; phones: string[]; emails: string[] }> = [];
  let cur: (typeof cards)[number] | null = null;
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const rawKey = line.slice(0, idx);
    let value = line.slice(idx + 1);
    // "item1.TEL;type=CELL" → TEL
    const [prop, ...params] = rawKey.split(";");
    const key = prop.replace(/^item\d+\./i, "").toUpperCase();
    if (key === "BEGIN" && /vcard/i.test(value)) {
      cur = { phones: [], emails: [] };
      continue;
    }
    if (key === "END" && /vcard/i.test(value)) {
      if (cur) cards.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (params.some((p) => /quoted-printable/i.test(p))) value = decodeQP(value);
    if (key === "FN") cur.name = unescapeValue(value);
    else if (key === "N") {
      // N:Apellido;Nombre;Segundo;Prefijo;Sufijo
      const [last, first, middle] = value.split(";").map(unescapeValue);
      cur.n = [first, middle, last].filter(Boolean).join(" ");
    } else if (key === "TEL") cur.phones.push(value.replace(/^tel:/i, ""));
    else if (key === "EMAIL") cur.emails.push(unescapeValue(value));
  }
  return cleanBookContacts(cards.map((c) => ({ name: c.name || c.n, phones: c.phones, emails: c.emails })));
};
