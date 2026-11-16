"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowRight, Coins, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccounts } from "@/hooks/use-data";
import { summarizeExchanges, type ExchangeSide } from "@/lib/domain/exchanges";
import type { Installment } from "@/lib/domain/types";
import { formatMoney, formatShortDate } from "@/lib/format";
import { useNewTransactionSheet } from "./new-transaction-sheet";

/**
 * Cambios de moneda del mes: cuántos dólares vendió/compró, cuántos pesos
 * recibió/pagó y a qué cotización promedio, más el detalle de cada cambio.
 * No se muestra si no hubo cambios (salvo `showEmpty`).
 */
export function ExchangeSummaryCard({
  installments,
  showList = true,
  showEmpty = false,
  maxItems = 6,
}: {
  /** Patas del mes (sin filtrar por cuenta: un cambio puede ir de una cuenta a otra). */
  installments: Installment[];
  showList?: boolean;
  showEmpty?: boolean;
  maxItems?: number;
}) {
  const { data: accounts } = useAccounts();
  const { open } = useNewTransactionSheet();
  const summary = useMemo(() => summarizeExchanges(installments), [installments]);
  const accName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  if (summary.ops.length === 0 && !showEmpty) return null;

  const shown = summary.ops.slice(0, maxItems);
  const more = summary.ops.length - shown.length;

  return (
    <Card className="rounded-3xl">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
          <Coins className="size-4" />
          Cambios de dólares del mes
        </CardTitle>
        <button
          type="button"
          onClick={() => open("exchange")}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium hover:bg-muted/80"
        >
          <Plus className="size-3" />
          Registrar
        </button>
      </CardHeader>
      <CardContent className="space-y-3 pt-1">
        {summary.ops.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            No registraste cambios este mes. Cuando vendas o compres dólares (en el banco, en Mercado
            Pago o con alguien), cargalo acá y vas a ver a cuánto cambiaste en promedio.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {summary.sold.count > 0 && <SideTile title="Vendiste" side={summary.sold} sell />}
            {summary.bought.count > 0 && <SideTile title="Compraste" side={summary.bought} />}
          </div>
        )}

        {showList && shown.length > 0 && (
          <ul className="divide-y text-sm">
            {shown.map((o) => {
              const from = accName.get(o.fromAccountId) ?? "—";
              const to = accName.get(o.toAccountId) ?? "—";
              return (
                <li key={o.transactionId} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{o.description || (o.side === "sell" ? "Venta" : "Compra")}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatShortDate(o.date)} · {from === to ? from : `${from} → ${to}`}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className="flex items-center justify-end gap-1 font-medium">
                      {formatMoney(o.side === "sell" ? o.usd : o.ars, o.side === "sell" ? "USD" : "ARS")}
                      <ArrowRight className="size-3 text-muted-foreground" />
                      {formatMoney(o.side === "sell" ? o.ars : o.usd, o.side === "sell" ? "ARS" : "USD")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      a {formatMoney(o.rate, "ARS")}
                      {o.diff !== 0 && (
                        <span className={o.diff < 0 ? "text-destructive" : "text-success"}>
                          {" "}
                          · dif. {o.diff > 0 ? "+" : "−"}
                          {formatMoney(Math.abs(o.diff), "ARS")}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {showList && more > 0 && (
          <Link href="/movimientos?kind=exchange" className="block text-xs font-medium text-brand hover:underline">
            Ver los {summary.ops.length} cambios
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function SideTile({ title, side, sell }: { title: string; side: ExchangeSide; sell?: boolean }) {
  return (
    <div className="rounded-2xl bg-muted/50 px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title} · {side.count} {side.count === 1 ? "vez" : "veces"}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">
        {formatMoney(side.usd, "USD")}
      </div>
      <div className="text-sm tabular-nums text-muted-foreground">
        {sell ? "recibiste" : "pagaste"} {formatMoney(side.ars, "ARS")}
      </div>
      <div className="mt-1 text-xs tabular-nums">
        Promedio <span className="font-semibold">{formatMoney(side.avgRate, "ARS")}</span>
      </div>
      {side.diff !== 0 && (
        <div
          className={`text-xs tabular-nums ${side.diff < 0 ? "text-destructive" : "text-success"}`}
          title="Suma de diferencias contra la cotización pactada (redondeos, comisiones)"
        >
          Diferencias: {side.diff > 0 ? "+" : "−"}
          {formatMoney(Math.abs(side.diff), "ARS")} {side.diff > 0 ? "a favor" : "en contra"}
        </div>
      )}
    </div>
  );
}
