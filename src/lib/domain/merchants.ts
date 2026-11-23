/**
 * Clave estable de un comercio a partir de la descripción del resumen, para
 * recordar su categoría: "MERPAGO*RAPPI 2231" → "rappi",
 * "COTO CICSA SUC 112" → "coto", "YPF SERVICLUB 2231" → "ypf serviclub".
 */

// Procesadores de pago que aparecen como prefijo (MERPAGO*RAPPI, DLO*SPOTIFY…).
const PROCESSOR_PREFIX = /^(merpago|mercadopago|mp|dlo|dlocal|payu|pago|pagos|pp|paypal|sq|tst|stripe)\s*\*\s*/;

// Palabras que no ayudan a identificar el comercio.
const NOISE = new Set([
  "suc", "sucursal", "cicsa", "sa", "srl", "sas", "sacifia", "saciei", "sacif", "saci",
  "ar", "arg", "argentina", "caba", "bs", "as", "com", "www", "the", "de", "la", "el",
  "y", "e", "inc", "llc", "ltd",
]);

export const normalizeMerchant = (description: string): string => {
  let s = description
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  s = s.replace(PROCESSOR_PREFIX, "").replace(/^mercado\s*pago\s+/, "");
  const words = s
    .replace(/\.com\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !NOISE.has(w));
  return words.slice(0, 2).join(" ") || s.replace(/[^a-z0-9]/g, "").slice(0, 20);
};

const plainText = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** Lo mínimo de un fijo para reconocerlo en un renglón del resumen. */
export interface FijoMatchInfo {
  id: string;
  name: string;
  accountId: string;
  kind: string;
  active: boolean;
  /** Cómo figura en el resumen (normalizeMerchant), si se dio de alta desde uno. */
  matchKey?: string | null;
}

/**
 * El fijo (gasto, activo, de esa tarjeta) al que corresponde un renglón del
 * resumen: primero por cómo figura en el resumen ("ASOC MUTUAL S ASOC MUTU"
 * → fijo "Prepaga"), después por el nombre ("HELP HBOMAX C" → "HBO Max").
 */
export const fijoForLine = <T extends FijoMatchInfo>(
  fijos: readonly T[],
  accountId: string,
  description: string,
): T | null => {
  const mine = fijos.filter((f) => f.active && f.kind === "expense" && f.accountId === accountId);
  const key = normalizeMerchant(description);
  const byKey = mine.find((f) => f.matchKey && f.matchKey === key);
  if (byKey) return byKey;
  const text = plainText(description);
  const words = description
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/);
  return (
    mine.find((f) => {
      const name = plainText(f.name);
      if (name.length < 3) return false;
      // Nombres cortos solo como palabra entera: "Luz" no es "LUZURIAGA BAR".
      return (
        name === text ||
        words.includes(name) ||
        (name.length >= 5 && text.includes(name)) ||
        (text.length >= 5 && name.includes(text))
      );
    }) ?? null
  );
};
