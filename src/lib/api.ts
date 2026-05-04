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
  if (init.body && !headers.has("Content-Type")) {
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
