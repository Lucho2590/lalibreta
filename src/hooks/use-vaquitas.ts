"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuth } from "./use-auth";
import { useCollection } from "./use-collection";
import type { Vaquita, VaquitaExpense, VaquitaPayment } from "@/lib/domain/vaquitas";

/** Vaquitas donde participo. */
export function useVaquitas() {
  const { user } = useAuth();
  const q = useMemo(
    () => (user ? query(collection(db, "vaquitas"), where("uids", "array-contains", user.uid)) : null),
    [user],
  );
  return useCollection<Vaquita>(q);
}

/** Una vaquita en vivo. `missing`: no existe o no participo. */
export function useVaquita(id: string) {
  const { user } = useAuth();
  const [state, setState] = useState<{ id: string; data: Vaquita | null; missing: boolean } | null>(null);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(db, "vaquitas", id),
      (snap) =>
        setState({
          id,
          data: snap.exists() ? ({ id: snap.id, ...snap.data() } as Vaquita) : null,
          missing: !snap.exists(),
        }),
      () => setState({ id, data: null, missing: true }),
    );
  }, [id, user]);
  const current = state?.id === id ? state : null;
  return { data: current?.data ?? null, missing: current?.missing ?? false, loading: !current };
}

export function useVaquitaExpenses(id: string, enabled = true) {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user && enabled ? query(collection(db, "vaquitas", id, "expenses"), orderBy("date", "desc")) : null,
    [user, id, enabled],
  );
  return useCollection<VaquitaExpense>(q);
}

export function useVaquitaPayments(id: string, enabled = true) {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user && enabled ? query(collection(db, "vaquitas", id, "payments"), orderBy("date", "desc")) : null,
    [user, id, enabled],
  );
  return useCollection<VaquitaPayment>(q);
}
