"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import { useAuth } from "./use-auth";

export interface UsdRate {
  rate: number;
  date: string;
  source: "BCRA";
}

// Una sola consulta por sesión de la página (la cotización cambia una vez por día).
let cached: Promise<UsdRate | null> | null = null;

const fetchRate = () => {
  cached ??= apiJson<UsdRate>("/api/fx/usd").catch((err) => {
    console.warn("[fx] no se pudo obtener la cotización", err);
    cached = null;
    return null;
  });
  return cached;
};

/** Cotización oficial del dólar (BCRA), o null mientras carga / si falla. */
export function useUsdRate(): UsdRate | null {
  const { user } = useAuth();
  const [rate, setRate] = useState<UsdRate | null>(null);
  useEffect(() => {
    if (!user) return;
    let active = true;
    void fetchRate().then((r) => {
      if (active) setRate(r);
    });
    return () => {
      active = false;
    };
  }, [user]);
  return rate;
}
