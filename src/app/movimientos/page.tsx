"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDownRight, ArrowUpRight, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMonth } from "@/hooks/use-month";
import {
  useAccounts,
  useInstallmentsForMonth,
  useSharedAsOwner,
} from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { TransactionList } from "@/components/transactions/transaction-list";
import { useNewTransactionSheet } from "@/components/transactions/new-transaction-sheet";
import { formatCurrency, formatMonth } from "@/lib/format";
import { computeMonthlyBalance } from "@/lib/domain/balance";
import { buildSharedByTxId } from "@/lib/domain/shared-effective";

export default function MovimientosPage() {
  const params = useSearchParams();
  const accountFilter = params.get("account");
  const kindFilter = params.get("kind");
  const { monthKey, year, month } = useMonth();
  const { user } = useAuth();
  const { data: installments, loading } = useInstallmentsForMonth(monthKey);
  const { data: accounts } = useAccounts();
  const { data: shared } = useSharedAsOwner();
  const { open } = useNewTransactionSheet();

  const sharedByTxId = useMemo(() => buildSharedByTxId(shared), [shared]);
  const adj = useMemo(
    () => (user ? { sharedByTxId, ownerUid: user.uid } : undefined),
    [sharedByTxId, user],
  );

  const filtered = useMemo(() => {
    return installments.filter((i) => {
      if (accountFilter && i.accountId !== accountFilter) return false;
      if (kindFilter === "expense" && i.kind !== "expense") return false;
      if (kindFilter === "income" && i.kind !== "income") return false;
      if (kindFilter === "transfer" && i.kind !== "transfer") return false;
      return true;
    });
  }, [installments, accountFilter, kindFilter]);

  const balance = useMemo(
    () => computeMonthlyBalance(installments, monthKey, adj),
    [installments, monthKey, adj],
  );

  const updateFilter = (key: string, value: string | null) => {
    const usp = new URLSearchParams(params.toString());
    if (value === null || value === "") usp.delete(key);
    else usp.set(key, value);
    const search = usp.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  };

  const accountName = accounts.find((a) => a.id === accountFilter)?.name;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Movimientos</h1>
          <p className="text-sm text-muted-foreground">{formatMonth(year, month)}</p>
        </div>
        <Button
          className="hidden md:inline-flex bg-brand-grad text-white hover:opacity-95"
          onClick={() => open()}
        >
          Nuevo movimiento
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Stat
          label="Ingresos"
          value={balance.income}
          tone="success"
          icon={<ArrowUpRight className="size-4" />}
        />
        <Stat
          label="Gastos"
          value={balance.expense}
          icon={<ArrowDownRight className="size-4" />}
        />
        <Stat
          label="Balance"
          value={balance.balance}
          tone={balance.balance >= 0 ? "success" : "destructive"}
          icon={<Wallet className="size-4" />}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={kindFilter ?? "all"}
          onValueChange={(v) => updateFilter("kind", v === "all" ? null : v)}
        >
          <TabsList>
            <TabsTrigger value="all">Todos</TabsTrigger>
            <TabsTrigger value="expense">Gastos</TabsTrigger>
            <TabsTrigger value="income">Ingresos</TabsTrigger>
            <TabsTrigger value="transfer">Transfer.</TabsTrigger>
          </TabsList>
        </Tabs>

        {accountFilter && (
          <button
            type="button"
            onClick={() => updateFilter("account", null)}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs font-medium hover:bg-muted/80"
          >
            {accountName ?? accountFilter}
            <X className="size-3" />
          </button>
        )}
      </div>

      {loading ? (
        <SkeletonList />
      ) : filtered.length === 0 ? (
        <Card className="rounded-3xl">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Sin movimientos en este mes.
          </CardContent>
        </Card>
      ) : (
        <TransactionList
          items={filtered}
          sharedByTxId={sharedByTxId}
          ownerUid={user?.uid}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone?: "success" | "destructive";
  icon?: React.ReactNode;
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "";
  return (
    <Card className="rounded-2xl">
      <CardContent className="py-4">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>
          {formatCurrency(value)}
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="rounded-2xl">
          <CardContent className="flex items-center gap-3 py-4">
            <div className="size-9 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
              <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
