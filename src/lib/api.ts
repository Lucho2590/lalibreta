import { auth } from "@/lib/firebase/client";

/**
 * Fetch wrapper que adjunta el id token de Firebase como Bearer
 * al header Authorization. Para todas las llamadas a /api/...
 */
export const apiFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const user = auth.currentUser;
  const headers = new Headers(init.headers);
  if (user) {
    const token = await user.getIdToken();
    headers.set("Authorization", `Bearer ${token}`);
  }
  // Con FormData (subir archivos) el navegador arma el Content-Type con el boundary.
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
};

export const apiJson = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
};

/**
 * POST con body JSON. Si falla, tira un Error con el mensaje del server
 * ({ error }) para mostrarlo tal cual en un toast.
 */
export const apiPost = async <T = { ok: true }>(path: string, body: unknown): Promise<T> => {
  const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `No se pudo completar (${res.status})`);
  return data;
};

/** Mensaje de un error para mostrar al usuario. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : "No se pudo completar");
