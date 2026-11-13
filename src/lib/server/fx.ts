import "server-only";

import { todayYMD } from "./time";

/**
 * Cotización oficial del dólar según el BCRA (API de Estadísticas
 * Cambiarias, sin clave). Es la de referencia: no es la que paga cada banco
 * ni el MEP, así que si el usuario dice a cuánto vendió, se usa su número.
 */

const BASE = "https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD";
const TTL_MS = 60 * 60 * 1000;

export interface FxRate {
  rate: number;
  /** YYYY-MM-DD del día hábil de la cotización. */
  date: string;
  source: "BCRA";
}

const cache = new Map<string, { value: FxRate; at: number }>();

const minusDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** Cotización del último día hábil ≤ date (por defecto, hoy). */
export const getUsdRate = async (date: string = todayYMD()): Promise<FxRate> => {
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const url = `${BASE}?fechadesde=${minusDays(date, 10)}&fechahasta=${date}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`BCRA ${res.status}`);
  const json = (await res.json()) as {
    results?: Array<{ fecha: string; detalle?: Array<{ codigoMoneda: string; tipoCotizacion: number }> }>;
  };
  const rows = (json.results ?? [])
    .map((r) => ({
      date: r.fecha,
      rate: r.detalle?.find((d) => d.codigoMoneda === "USD")?.tipoCotizacion ?? 0,
    }))
    .filter((r) => r.rate > 0 && r.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (rows.length === 0) throw new Error("El BCRA no devolvió cotización");
  const value: FxRate = { rate: rows[0].rate, date: rows[0].date, source: "BCRA" };
  cache.set(date, { value, at: Date.now() });
  return value;
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
