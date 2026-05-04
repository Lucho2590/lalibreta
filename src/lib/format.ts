export const formatCurrency = (n: number): string =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(n);

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
