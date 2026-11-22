"use client";

import { budgetStatus } from "@/lib/domain/list-model";
import type { Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Lo gastado contra el tope. Sin tope muestra solo lo gastado. `projected`
 * (lo gastado + lo estimado de lo que falta) se muestra como una marca más
 * clara detrás de la barra.
 */
export function BudgetBar({
  spent,
  budget,
  currency,
  projected,
  missing,
  compact,
}: {
  spent: number;
  budget?: number | null;
  currency: Currency;
  projected?: number | null;
  missing?: Currency[];
  compact?: boolean;
}) {
  const s = budgetStatus(spent, budget);
  const projPct = s.budget && projected ? Math.min(100, (projected / s.budget) * 100) : 0;
  const projectedOver = !!(s.budget && projected && projected > s.budget);

  if (!s.budget && spent <= 0 && (compact || !projected)) return null;

  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("tabular-nums", compact ? "text-xs" : "text-sm")}>
          <span className="font-semibold">{formatMoney(spent, currency)}</span>
          {s.budget ? (
            <span className="text-muted-foreground"> de {formatMoney(s.budget, currency)}</span>
          ) : (
            <span className="text-muted-foreground"> gastado</span>
          )}
        </span>
        {s.budget != null && s.remaining != null && (
          <span
            className={cn(
              "shrink-0 tabular-nums",
              compact ? "text-[11px]" : "text-xs",
              s.over ? "font-semibold text-destructive" : "text-muted-foreground",
            )}
          >
            {s.over ? `Te pasaste ${formatMoney(-s.remaining, currency)}` : `Quedan ${formatMoney(s.remaining, currency)}`}
          </span>
        )}
      </div>
      {s.budget != null && (
        <div className={cn("relative overflow-hidden rounded-full bg-muted", compact ? "h-1.5" : "h-2")}>
          {projPct > s.pct && (
            <div
              className={cn(
                "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none",
                projectedOver ? "bg-destructive/25" : "bg-primary/20",
              )}
              style={{ width: `${projPct}%` }}
            />
          )}
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none",
              s.over ? "bg-destructive" : "bg-brand-grad",
            )}
            style={{ width: `${s.pct}%` }}
          />
        </div>
      )}
      {!compact && projected != null && projected > spent && (
        <p className={cn("text-[11px]", projectedOver ? "text-destructive" : "text-muted-foreground")}>
          Previsto con lo que falta: {formatMoney(projected, currency)}
          {projectedOver && s.budget ? ` (te pasarías ${formatMoney(projected - s.budget, currency)})` : ""}
        </p>
      )}
      {!compact && missing && missing.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Sin cotización para {missing.join(", ")}: esos gastos no suman acá.
        </p>
      )}
    </div>
  );
}
