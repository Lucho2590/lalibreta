"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { db } from "@/lib/firebase/client";
import { applyNavOrder } from "@/components/layout/nav-items";

/**
 * Orden del menú (sidebar en la compu, "Más" en el celu). Es uno solo y se
 * guarda en users/{uid}.navOrder, así se ve igual en todos los dispositivos.
 */
export function useNavOrder() {
  const { user } = useAuth();
  const [saved, setSaved] = useState<string[] | null>(null);
  // Orden optimista: se ve al soltar, sin esperar a Firestore (si no, "salta").
  const [pending, setPending] = useState<string[] | null>(null);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        const order = snap.data()?.navOrder;
        setSaved(Array.isArray(order) ? (order as string[]) : null);
      },
      (err) => console.error("navOrder", err),
    );
  }, [user]);

  const items = useMemo(() => applyNavOrder(pending ?? saved), [pending, saved]);

  const saveOrder = useCallback(
    async (hrefs: string[]) => {
      if (!user) return;
      setPending(hrefs);
      try {
        await setDoc(doc(db, "users", user.uid), { navOrder: hrefs }, { merge: true });
        setSaved(hrefs);
      } catch (err) {
        toast.error("No se pudo guardar el orden del menú");
        console.error(err);
      } finally {
        setPending(null);
      }
    },
    [user],
  );

  return { items, saveOrder };
}
