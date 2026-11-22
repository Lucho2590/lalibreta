"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPost } from "@/lib/api";
import { parseContactQuery, type ContactQuery } from "@/lib/domain/phone";

export type LookupState = "self" | "connected" | "outgoing" | "incoming" | "none";

export type LookupResult =
  | { kind: "email" | "phone"; value: string; found: false }
  | { kind: "email" | "phone"; value: string; found: true; name: string; photoURL: string | null; state: LookupState };

/**
 * Mientras escribe un email o un WhatsApp, se fija (con una pausa) si esa
 * persona usa La Libreta.
 */
export function useContactLookup(raw: string, delay = 500) {
  const query: ContactQuery = parseContactQuery(raw);
  const key = query ? `${query.kind}:${query.value}` : "";
  const [result, setResult] = useState<LookupResult | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await apiPost<LookupResult>("/api/connections/lookup", { q: key.slice(key.indexOf(":") + 1) });
        if (cancelled) return;
        setResult(r);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setResult(null);
        setError(err instanceof Error ? err.message : "No se pudo buscar");
      } finally {
        if (!cancelled) setLoadedKey(key);
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key, delay, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const fresh = !!key && loadedKey === key;
  return {
    query,
    loading: !!key && !fresh,
    result: fresh && result && `${result.kind}:${result.value}` === key ? result : null,
    error: fresh ? error : null,
    refresh,
  };
}
