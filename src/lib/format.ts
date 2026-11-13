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
