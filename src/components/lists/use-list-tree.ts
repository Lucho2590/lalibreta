"use client";

import { useMemo } from "react";
import { useLists } from "@/hooks/use-data";
import { useFxRates } from "@/hooks/use-fx-rates";
import { childrenIndex, type ListNode } from "@/lib/domain/list-model";

/** Todos mis grupos y listas armados en árbol, más las cotizaciones para los totales. */
export function useListTree() {
  const { data: nodes, loading, error } = useLists();
  const fx = useFxRates();
  const index = useMemo(() => childrenIndex(nodes), [nodes]);
  const byId = useMemo(() => new Map<string, ListNode>(nodes.map((n) => [n.id, n])), [nodes]);
  return { nodes, index, byId, loading, error, rates: fx?.rates ?? null };
}
