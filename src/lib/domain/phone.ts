/**
 * Teléfonos y emails para buscar a alguien ("¿esta persona usa La Libreta?")
 * e invitarlo. Helpers puros: los usan la web, el server y el agente.
 *
 * Los números quedan como el waId de WhatsApp (solo dígitos, con código de
 * país). Los de Argentina, como 549 + característica + número (sin 0 ni 15),
 * que es como llegan al webhook y como se guardan en whatsappLinks.
 */

export const looksLikeEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());

/** Tiene pinta de teléfono: solo dígitos, espacios, +, -, paréntesis y puntos, y al menos 8 dígitos. */
export const looksLikePhone = (raw: string) =>
  /^[+\d][\d\s().-]*$/.test(raw.trim()) && raw.replace(/\D/g, "").length >= 8;

/** Número nacional argentino (sin 0 ni 54) → 10 dígitos, sacando el 15 si vino. */
const arNational = (n: string): string | null => {
  let d = n.replace(/^0+/, "");
  // Escrito con el 15 y sin característica ("15 5555-1234"): es de Buenos Aires.
  if (d.length === 10 && d.startsWith("15")) d = `11${d.slice(2)}`;
  // Con característica y el 15 ("011 15 5555-1234", "223 15 555-1234"): las
  // características tienen 2 a 4 dígitos, el 15 va justo después.
  if (d.length === 12) {
    for (const i of [2, 3, 4]) {
      if (d.slice(i, i + 2) === "15") {
        d = d.slice(0, i) + d.slice(i + 2);
        break;
      }
    }
  }
  return d.length === 10 ? d : null;
};

/**
 * Un teléfono escrito como sea → waId ("5491155551234"), o null si no se
 * entiende. Sin código de país se asume Argentina.
 */
export const normalizePhone = (raw: string): string | null => {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  let international = trimmed.startsWith("+");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }
  if (!digits) return null;

  // Argentina con código de país (+54 9 11…, 54 11…).
  if (digits.startsWith("54") && (international || digits.length >= 12)) {
    let rest = digits.slice(2);
    if (rest.startsWith("9")) rest = rest.slice(1);
    const n = arNational(rest);
    return n ? `549${n}` : null;
  }
  if (international) return digits.length >= 8 && digits.length <= 15 ? digits : null;
  const n = arNational(digits);
  return n ? `549${n}` : null;
};

/**
 * Las formas en que ese número puede estar guardado como waId: los de
 * Argentina a veces llegan sin el 9 (54 + 10 dígitos).
 */
export const phoneVariants = (waId: string): string[] =>
  waId.startsWith("549") && waId.length === 13 ? [waId, `54${waId.slice(3)}`] : [waId];

/** "5491155551234" → "+54 9 11 5555-1234" (los de Argentina; el resto, +dígitos). */
export const formatPhone = (waId: string) => {
  if (waId.startsWith("549") && waId.length === 13) {
    const n = waId.slice(3);
    const area = n.startsWith("11") ? 2 : 3;
    return `+54 9 ${n.slice(0, area)} ${n.slice(area, n.length - 4)}-${n.slice(-4)}`;
  }
  return `+${waId}`;
};

/** Link que abre un chat de WhatsApp con ese número y el texto ya escrito. */
export const waMeLink = (waId: string, text: string) => `https://wa.me/${waId}?text=${encodeURIComponent(text)}`;

/** Mensaje para invitar a alguien a La Libreta (lo manda el usuario desde su WhatsApp). */
export const inviteMessage = (myName: string | null | undefined, appUrl: string) =>
  `¡Hola! ${myName ? `Soy ${myName.split(" ")[0]}. ` : ""}Te invito a La Libreta, la app donde anoto mis gastos: ` +
  `ahí podemos repartir gastos, armar vaquitas y anotar quién le debe a quién. Se carga hasta por WhatsApp. ` +
  `Entrá acá y creá tu cuenta: ${appUrl}`;

/** Lo que escribió en el buscador de contactos: un email, un teléfono o nada válido. */
export type ContactQuery = { kind: "email"; value: string } | { kind: "phone"; value: string } | null;

export const parseContactQuery = (raw: string): ContactQuery => {
  const q = raw.trim();
  if (looksLikeEmail(q)) return { kind: "email", value: q.toLowerCase() };
  if (looksLikePhone(q)) {
    const phone = normalizePhone(q);
    return phone ? { kind: "phone", value: phone } : null;
  }
  return null;
};
