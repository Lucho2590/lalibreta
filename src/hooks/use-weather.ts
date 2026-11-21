"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import { LOCATION_EVENT } from "@/lib/pwa/location-client";
import type { WeatherReport } from "@/lib/domain/weather";
import { useAuth } from "./use-auth";

export type WeatherData = Omit<WeatherReport, "location"> & {
  location: WeatherReport["location"] | null;
  /** Eligió "Dejar de usar mi ubicación". */
  optOut: boolean;
};

const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; promise: Promise<WeatherData | null> } | null = null;
/** Lo último que llegó: al volver al inicio se muestra enseguida (sin esperar ni animar). */
let lastValue: { at: number; data: WeatherData } | null = null;

const freshValue = () => (lastValue && Date.now() - lastValue.at < TTL_MS ? lastValue.data : null);

const fetchWeather = (force = false) => {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.promise;
  const promise = apiJson<WeatherData>("/api/weather")
    .then((data) => {
      lastValue = { at: Date.now(), data };
      return data;
    })
    .catch((err) => {
      console.warn("[clima] no se pudo obtener", err);
      cached = null;
      return null;
    });
  cached = { at: Date.now(), promise };
  return promise;
};

/** Clima y alertas en la ubicación guardada. `data.location` null = no activó la ubicación. */
export function useWeather() {
  const { user } = useAuth();
  const [data, setData] = useState<WeatherData | null>(freshValue);
  const [loading, setLoading] = useState(() => freshValue() === null);

  const load = useCallback((force: boolean) => {
    void fetchWeather(force).then((d) => {
      setData(d);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    load(false);
    const onLocation = () => load(true);
    window.addEventListener(LOCATION_EVENT, onLocation);
    return () => window.removeEventListener(LOCATION_EVENT, onLocation);
  }, [user, load]);

  return { data, loading, refresh: () => load(true) };
}
