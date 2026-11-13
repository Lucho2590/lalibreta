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
