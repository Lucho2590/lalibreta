"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import type { FxRatesMap } from "@/lib/domain/balance";
import { CURRENCY_META, FOREIGN_CURRENCIES } from "@/lib/domain/types";
import { useAuth } from "./use-auth";

export interface FxRates {
  /** Pesos por unidad de cada moneda de la app que publica el BCRA. */
  rates: FxRatesMap;
  /** YYYY-MM-DD del día hábil de la cotización. */
  date: string;
  source: "BCRA";
}

interface ApiFxRates {
  date: string;
  source: "BCRA";
  rates: Array<{ code: string; rate: number }>;
}

// Una sola consulta por sesión de la página (las cotizaciones cambian una vez por día).
let cached: Promise<FxRates | null> | null = null;

const fetchRates = () => {
  cached ??= apiJson<ApiFxRates>("/api/fx")
    .then((r): FxRates => {
      const rates: FxRatesMap = {};
      for (const c of FOREIGN_CURRENCIES) {
        const q = r.rates.find((x) => x.code === CURRENCY_META[c].bcraCode);
        if (q && q.rate > 0) rates[c] = q.rate;
      }
      return { rates, date: r.date, source: r.source };
    })
    .catch((err) => {
      console.warn("[fx] no se pudieron obtener las cotizaciones", err);
      cached = null;
      return null;
    });
  return cached;
};

/** Cotizaciones oficiales (BCRA) de las monedas de la app, o null mientras carga / si falla. */
export function useFxRates(): FxRates | null {
  const { user } = useAuth();
  const [rates, setRates] = useState<FxRates | null>(null);
  useEffect(() => {
    if (!user) return;
    let active = true;
    void fetchRates().then((r) => {
      if (active) setRates(r);
    });
    return () => {
      active = false;
    };
  }, [user]);
  return rates;
}
