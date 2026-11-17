"use client";

import { useSearchParams, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";
import { monthKey, parseMonthKey } from "@/lib/domain/types";

export function useMonth() {
  const pathname = usePathname();
  const params = useSearchParams();

  const value = useMemo(() => {
    const raw = params.get("month");
    if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
    const now = new Date();
    return monthKey(now.getFullYear(), now.getMonth() + 1);
  }, [params]);

  const setValue = useCallback(
    (next: string) => {
      const usp = new URLSearchParams(params.toString());
      usp.set("month", next);
      // Sin ir al servidor: el mes vive en la URL y todo se calcula en el
      // cliente. router.replace pedía la página de nuevo a Vercel y, con el
      // servidor "frío", cambiar de mes tardaba varios segundos (parecía que
      // no andaba). replaceState se sincroniza con useSearchParams.
      window.history.replaceState(null, "", `${pathname}?${usp.toString()}`);
    },
    [params, pathname],
  );

  const shift = useCallback(
    (delta: number) => {
      const { year, month } = parseMonthKey(value);
      const total = month - 1 + delta;
      const newYear = year + Math.floor(total / 12);
      const newMonth = ((total % 12) + 12) % 12 + 1;
      setValue(monthKey(newYear, newMonth));
    },
    [value, setValue],
  );

  return { monthKey: value, ...parseMonthKey(value), setMonth: setValue, shift };
}
