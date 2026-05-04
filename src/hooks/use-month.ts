"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";
import { monthKey, parseMonthKey } from "@/lib/domain/types";

export function useMonth() {
  const router = useRouter();
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
      router.replace(`${pathname}?${usp.toString()}`);
    },
    [params, pathname, router],
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
