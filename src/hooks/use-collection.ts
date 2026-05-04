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
}

export function useCollection<T>(
  q: Query<DocumentData> | null,
): CollectionState<T> {
  const [state, setState] = useState<CollectionState<T>>({
    data: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
        setState({ data, loading: false, error: null });
      },
      (error) => setState({ data: [], loading: false, error }),
    );
    return unsub;
  }, [q]);

  return state;
}
