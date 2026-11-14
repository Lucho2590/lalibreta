"use client";

import { apiFetch } from "@/lib/api";

/** Sesión del panel de administrador (token del PIN, dura 12 h). */
const KEY = "lalibreta.adminToken";

export const getAdminToken = (): string | null => {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const exp = Number(raw.split(".")[1]);
  if (!exp || exp < Date.now()) {
    localStorage.removeItem(KEY);
    return null;
  }
  return raw;
};

export const setAdminToken = (token: string) => localStorage.setItem(KEY, token);
export const clearAdminToken = () => localStorage.removeItem(KEY);

export const unlockAdmin = async (pin: string): Promise<{ ok: true } | { ok: false; error: string }> => {
  const res = await apiFetch("/api/admin/unlock", { method: "POST", body: JSON.stringify({ pin }) });
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !data.token) return { ok: false, error: data.error ?? "PIN incorrecto" };
  setAdminToken(data.token);
  return { ok: true };
};

export const adminFetch = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  const token = getAdminToken();
  if (token) headers.set("X-Admin-Token", token);
  return apiFetch(path, { ...init, headers });
};
