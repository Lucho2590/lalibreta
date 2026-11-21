"use client";

import {
  type DocumentData,
  type Query,
  onSnapshot,
} from "firebase/firestore";
import { useEffect, useState } from "react";

export interface CollectionState<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
  /**
   * La consulta cambió (ej. otro mes) y `data` todavía es de la anterior:
   * sirve para atenuar o no animar hasta que llegue lo nuevo.
   */
  stale: boolean;
}

const EMPTY: never[] = [];

interface InternalState<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
  source: Query<DocumentData> | null;
}

export function useCollection<T>(
  q: Query<DocumentData> | null,
): CollectionState<T> {
  const [state, setState] = useState<InternalState<T>>({
    data: [],
    loading: true,
    error: null,
    source: q,
  });

  useEffect(() => {
    if (!q) return;
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
        setState({ data, loading: false, error: null, source: q });
      },
      (error) => {
        console.error("[useCollection] snapshot error", error);
        setState({ data: [], loading: false, error, source: q });
      },
    );
    return unsub;
  }, [q]);

  // Sin consulta (ej. sin usuario): vacío y listo.
  if (!q) return { data: EMPTY as T[], loading: false, error: null, stale: false };
  return { data: state.data, loading: state.loading, error: state.error, stale: !state.loading && state.source !== q };
}
