"use client";

import { apiFetch, apiJson, apiPost } from "@/lib/api";

/**
 * Ubicación del teléfono para el clima. El navegador solo da el GPS con la
 * app abierta: se actualiza cada vez que se abre (ver LocationPrompt).
 */

export type GeoPermission = "granted" | "denied" | "prompt" | "unknown" | "unsupported";

export interface SavedLocation {
  place: string | null;
  province: string | null;
  source: "gps" | "whatsapp";
  updatedAt: number;
}

/** Se dispara cuando cambia la ubicación guardada (para refrescar el clima). */
export const LOCATION_EVENT = "lalibreta:location";

export const geoSupported = () => typeof navigator !== "undefined" && "geolocation" in navigator;

/** Estado del permiso. Safari viejo no soporta consultarlo: "unknown". */
export const geoPermission = async (): Promise<GeoPermission> => {
  if (!geoSupported()) return "unsupported";
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state;
  } catch {
    return "unknown";
  }
};

/** Avisa cuando el usuario cambia el permiso desde el navegador. Devuelve cómo dejar de escuchar. */
export const watchGeoPermission = (onChange: (state: GeoPermission) => void): (() => void) => {
  let status: PermissionStatus | null = null;
  const handler = () => status && onChange(status.state);
  navigator.permissions
    ?.query({ name: "geolocation" })
    .then((s) => {
      status = s;
      s.addEventListener("change", handler);
    })
    .catch(() => {});
  return () => status?.removeEventListener("change", handler);
};

/** Pide la posición (si el permiso no está dado, el navegador muestra el cartel). */
export const currentPosition = () =>
  new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      // Para el clima alcanza con la ubicación aproximada: más rápida y gasta menos batería.
      enableHighAccuracy: false,
      timeout: 20_000,
      maximumAge: 10 * 60 * 1000,
    }),
  );

export const isPermissionDenied = (err: unknown) =>
  typeof err === "object" && err !== null && (err as GeolocationPositionError).code === 1;

export const fetchSavedLocation = () =>
  apiJson<{ location: SavedLocation | null; optOut: boolean }>("/api/users/location");

/**
 * Lee el GPS y lo manda al server. `explicit`: lo pidió el usuario (botón
 * Activar); si no, y había pedido no usarla, el server no la guarda.
 */
export const pushLocation = async (explicit: boolean) => {
  const pos = await currentPosition();
  const res = await apiPost<{ location: SavedLocation | null; changed: boolean; optOut: boolean }>(
    "/api/users/location",
    { lat: pos.coords.latitude, lon: pos.coords.longitude, explicit },
  );
  if (res.location) window.dispatchEvent(new Event(LOCATION_EVENT));
  return res;
};

export const forgetLocation = async () => {
  const res = await apiFetch("/api/users/location", { method: "DELETE" });
  if (!res.ok) throw new Error("No se pudo completar");
  window.dispatchEvent(new Event(LOCATION_EVENT));
};

export const placeLabel = (loc: Pick<SavedLocation, "place" | "province">) =>
  [loc.place, loc.province].filter(Boolean).join(", ") || "tu zona";
