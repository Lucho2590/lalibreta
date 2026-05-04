"use client";

import { useState } from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useMonth } from "@/hooks/use-month";
import { useInstallmentsForMonth } from "@/hooks/use-data";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { TransactionList } from "@/components/transactions/transaction-list";
import { formatCurrency, formatMonth } from "@/lib/format";

export default function IngresosPage() {
  const [open, setOpen] = useState(false);
  const { monthKey, year, month } = useMonth();
  const { data: installments, loading } = useInstallmentsForMonth(monthKey);
  const incomes = installments.filter((i) => i.kind === "income");
  const total = incomes.reduce((s, i) => s + i.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ingresos</h1>
          <p className="text-sm text-muted-foreground">{formatMonth(year, month)}</p>
        </div>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={<Button className="bg-brand-grad text-white hover:opacity-95" />}
          >
            <Plus className="mr-1 size-4" /> Nuevo ingreso
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0"
          >
            <SheetHeader className="px-4 pt-4">
              <SheetTitle>Nuevo ingreso</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-6 pt-2">
              <TransactionForm defaultKind="income" onSubmitted={() => setOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <Card className="rounded-3xl">
        <CardContent className="flex items-center gap-4 py-5">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-success/10 text-success">
            <ArrowUpRight className="size-5" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Total ingresos
            </div>
            <div className="text-3xl font-bold tabular-nums text-success">
              {formatCurrency(total)}
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : incomes.length === 0 ? (
        <Card className="rounded-3xl">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Sin ingresos cargados en este mes.
          </CardContent>
        </Card>
      ) : (
        <TransactionList items={incomes} />
      )}
    </div>
  );
}
