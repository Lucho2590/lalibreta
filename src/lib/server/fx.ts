import "server-only";

import { FOREIGN_CURRENCIES, CURRENCY_META, type Currency } from "@/lib/domain/types";
import { todayYMD } from "./time";

/**
 * Cotizaciones oficiales del BCRA (API de Estadísticas Cambiarias, sin clave)
 * de todas las monedas que publica. Son de referencia: no es lo que paga cada
 * banco ni el MEP, así que si el usuario dice a cuánto cambió, se usa su número.
 */

const BASE = "https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones";
const TTL_MS = 60 * 60 * 1000;
/** Días hacia atrás que se prueban para saltear fines de semana y feriados. */
const MAX_LOOKBACK = 10;

export interface FxQuote {
  /** Código del BCRA (ISO salvo MXP = peso mexicano). */
  code: string;
  name: string;
  /** Pesos por unidad. */
  rate: number;
  /** Dólares por unidad (tipo de pase). */
  usdPerUnit: number | null;
}

export interface FxRates {
  /** YYYY-MM-DD del día hábil de la cotización. */
  date: string;
  source: "BCRA";
  rates: FxQuote[];
}

export interface FxRate {
  rate: number;
  /** YYYY-MM-DD del día hábil de la cotización. */
  date: string;
  source: "BCRA";
}

/** Sin cotización útil: el peso mismo, oro/plata (vienen en 0) y el dólar de referencia Com. 3500. */
const SKIP = new Set(["ARS", "REF", "XAU", "XAG"]);

const NAMES: Record<string, string> = {
  USD: "Dólar estadounidense",
  EUR: "Euro",
  GBP: "Libra esterlina",
  BRL: "Real",
  UYU: "Peso uruguayo",
  CLP: "Peso chileno",
  PYG: "Guaraní",
  BOB: "Boliviano",
  PEN: "Sol peruano",
  COP: "Peso colombiano",
  MXP: "Peso mexicano",
  CAD: "Dólar canadiense",
  AUD: "Dólar australiano",
  NZD: "Dólar neozelandés",
  CHF: "Franco suizo",
  JPY: "Yen",
  CNY: "Yuan",
  CNH: "Yuan offshore",
  HKD: "Dólar de Hong Kong",
  SGD: "Dólar de Singapur",
  ILS: "Shekel israelí",
  INR: "Rupia india",
  RUB: "Rublo ruso",
  TRY: "Lira turca",
  ZAR: "Rand sudafricano",
  DKK: "Corona danesa",
  NOK: "Corona noruega",
  SEK: "Corona sueca",
  CZK: "Corona checa",
  RSD: "Dinar serbio",
  VEB: "Bolívar venezolano",
  NIO: "Córdoba nicaragüense",
  AWG: "Florín arubeño",
  VND: "Dong vietnamita (cada 1.000)",
  XDR: "DEG (FMI)",
};

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()).trim();

const cache = new Map<string, { value: FxRates; at: number }>();

const minusDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

type BcraDetalle = {
  codigoMoneda: string;
  descripcion?: string;
  tipoPase?: number;
  tipoCotizacion?: number;
};

const fetchDay = async (ymd: string): Promise<FxQuote[]> => {
  const res = await fetch(`${BASE}?fecha=${ymd}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  // Sin datos para ese día (feriado, fin de semana, fecha futura) el BCRA a
  // veces responde 404/400 en vez de una lista vacía.
  if (res.status === 404 || res.status === 400) return [];
  if (!res.ok) throw new Error(`BCRA ${res.status}`);
  const json = (await res.json()) as { results?: { detalle?: BcraDetalle[] } };
  return (json.results?.detalle ?? [])
    .filter((d) => !SKIP.has(d.codigoMoneda) && (d.tipoCotizacion ?? 0) > 0)
    .map((d) => ({
      code: d.codigoMoneda,
      name: NAMES[d.codigoMoneda] ?? titleCase(d.descripcion ?? d.codigoMoneda),
      rate: d.tipoCotizacion as number,
      usdPerUnit: d.codigoMoneda === "USD" ? 1 : d.tipoPase && d.tipoPase > 0 ? d.tipoPase : null,
    }));
};

/** Todas las cotizaciones del último día hábil ≤ date (por defecto, hoy). */
export const getRates = async (requested: string = todayYMD()): Promise<FxRates> => {
  const today = todayYMD();
  const date = requested > today ? today : requested;
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  for (let back = 0; back <= MAX_LOOKBACK; back++) {
    const day = minusDays(date, back);
    const rates = await fetchDay(day);
    if (rates.length === 0) continue;
    const value: FxRates = { date: day, source: "BCRA", rates };
    cache.set(date, { value, at: Date.now() });
    return value;
  }
  throw new Error("El BCRA no devolvió cotizaciones");
};

/** Cotización de una moneda (código del BCRA) del último día hábil ≤ date. */
export const getRate = async (code: string, date?: string): Promise<FxRate> => {
  const all = await getRates(date);
  const q = all.rates.find((r) => r.code === code.toUpperCase());
  if (!q) throw new Error(`El BCRA no publica cotización de ${code}`);
  return { rate: q.rate, date: all.date, source: "BCRA" };
};

/** Cotización oficial del dólar del último día hábil ≤ date (por defecto, hoy). */
export const getUsdRate = (date?: string): Promise<FxRate> => getRate("USD", date);

/**
 * Pesos por unidad de las monedas que se usan en la app (EUR, GBP…), para
 * pasar saldos y gastos a pesos. Si el BCRA falla, devuelve null.
 */
export const tryGetAppRates = async (
  date?: string,
): Promise<{ rates: Partial<Record<Currency, number>>; date: string } | null> => {
  try {
    const all = await getRates(date);
    const rates: Partial<Record<Currency, number>> = {};
    for (const c of FOREIGN_CURRENCIES) {
      const q = all.rates.find((r) => r.code === CURRENCY_META[c].bcraCode);
      if (q) rates[c] = q.rate;
    }
    return { rates, date: all.date };
  } catch (err) {
    console.warn("[fx] no se pudieron obtener las cotizaciones", err);
    return null;
  }
};

/** Igual que getUsdRate pero sin tirar error (para mostrar equivalentes). */
export const tryGetUsdRate = async (date?: string): Promise<FxRate | null> => {
  try {
    return await getUsdRate(date);
  } catch (err) {
    console.warn("[fx] no se pudo obtener la cotización", err);
    return null;
  }
};
