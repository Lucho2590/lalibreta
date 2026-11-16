export const formatCurrency = (n: number): string =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(n);

const usdFormatter = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** "$ 1.200,50" o "US$ 1.200,5" según la moneda. */
export const formatMoney = (n: number, currency: "ARS" | "USD" = "ARS"): string =>
  currency === "USD"
    ? `${n < 0 ? "-" : ""}US$ ${usdFormatter.format(Math.abs(n))}`
    : formatCurrency(n);

export const currencyLabel = (c: "ARS" | "USD") => (c === "USD" ? "Dólares" : "Pesos");

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

export const formatMonth = (year: number, month: number): string =>
  `${MONTHS[month - 1]} ${year}`;

export const formatDate = (d: Date): string =>
  new Intl.DateTimeFormat("es-AR", { dateStyle: "medium" }).format(d);

export const formatShortDate = (d: Date): string =>
  new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit" }).format(d);

/**
 * Lee un monto como lo escribe la gente en Argentina:
 * "12.500" → 12500, "12.500,50" → 12500.5, "12,5" → 12.5, "12.5" → 12.5,
 * "$ 1.200" → 1200. Si no es un número, devuelve NaN.
 * Un solo punto seguido de exactamente 3 dígitos se toma como separador de miles.
 */
export const parseAmount = (raw: string | number | null | undefined): number => {
  if (typeof raw === "number") return raw;
  let s = (raw ?? "").trim().replace(/US\$|u\$s|\$|\s/gi, "");
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Con los dos, el último es el decimal y el otro separa miles.
    const [dec, thousands] = lastComma > lastDot ? [",", "."] : [".", ","];
    s = s.split(thousands).join("").replace(dec, ".");
  } else if (lastComma >= 0) {
    const parts = s.split(",");
    s = parts.length > 2 ? parts.join("") : s.replace(",", ".");
  } else if (lastDot >= 0) {
    const parts = s.split(".");
    if (parts.length > 2 || parts[1].length === 3) s = parts.join("");
  }
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
};

/**
 * Para inputs de monto: lo que escribió el usuario, prolijo ("74915.06" →
 * "74.915,06"). Si no es un número, lo deja como está.
 */
export const formatAmountInput = (raw: string): string => {
  const n = parseAmount(raw);
  if (!Number.isFinite(n)) return raw;
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
};
