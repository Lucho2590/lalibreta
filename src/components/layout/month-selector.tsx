"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMonth } from "@/hooks/use-month";
import { formatMonth } from "@/lib/format";

export function MonthSelector() {
  const { year, month, shift } = useMonth();
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" onClick={() => shift(-1)} aria-label="Mes anterior">
        <ChevronLeft className="size-5" />
      </Button>
      <div className="min-w-[140px] text-center text-sm font-medium">
        {formatMonth(year, month)}
      </div>
      <Button variant="ghost" size="icon" onClick={() => shift(1)} aria-label="Mes siguiente">
        <ChevronRight className="size-5" />
      </Button>
    </div>
  );
}
