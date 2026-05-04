"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMonth } from "@/hooks/use-month";
import { useAccounts, useCategories, useInstallmentsForMonth } from "@/hooks/use-data";
import {
  computeMonthlyBalance,
  sumByAccount,
  sumByCategory,
} from "@/lib/domain/balance";
import { formatCurrency, formatMonth } from "@/lib/format";
import { RecurringBanner } from "@/components/dashboard/recurring-banner";
import { CategoryIcon } from "@/components/category-icon";
import { AccountIcon, defaultIconForType } from "@/components/account-icon";

export default function Dashboard() {
  const { monthKey, year, month } = useMonth();
  const { data: installments, loading } = useInstallmentsForMonth(monthKey);
  const { data: categories } = useCategories();
  const { data: accounts } = useAccounts();

  const balance = useMemo(
    () => computeMonthlyBalance(installments, monthKey),
    [installments, monthKey],
  );
  const byCategory = useMemo(
    () => sumByCategory(installments, monthKey),
    [installments, monthKey],
  );
  const byAccount = useMemo(
    () => sumByAccount(installments, monthKey),
    [installments, monthKey],
  );

  const sortedCategories = [...byCategory.entries()]
    .map(([id, total]) => ({ cat: categories.find((c) => c.id === id), total }))
    .sort((a, b) => b.total - a.total);

  const sortedAccounts = [...byAccount.entries()]
    .map(([id, total]) => ({ acc: accounts.find((a) => a.id === id), total }))
    .sort((a, b) => b.total - a.total);

  const max = sortedCategories[0]?.total ?? 0;
  const positive = balance.balance >= 0;

  return (
    <div className="space-y-6">
      <div className="hidden md:flex md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inicio</h1>
          <p className="text-sm text-muted-foreground">{formatMonth(year, month)}</p>
        </div>
      </div>

      <RecurringBanner />

      <section className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2 overflow-hidden rounded-3xl bg-brand-grad p-6 text-white shadow-lg">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider opacity-80">
            {positive ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
            Balance del mes
          </div>
          <div className="mt-2 text-4xl font-bold tabular-nums md:text-5xl">
            {formatCurrency(balance.balance)}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <BalancePill
              icon={<ArrowUpRight className="size-3.5" />}
              label="Ingresos"
              value={balance.income}
            />
            <BalancePill
              icon={<ArrowDownRight className="size-3.5" />}
              label="Gastos"
              value={balance.expense}
            />
          </div>
        </div>

        <Card className="rounded-3xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Resumen</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-1">
            <SummaryRow label="Categorías con movimiento" value={sortedCategories.length} />
            <SummaryRow label="Cuentas con movimiento" value={sortedAccounts.length} />
            <SummaryRow
              label="Total movimientos"
              value={installments.filter((i) => i.billingMonth === monthKey).length}
            />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <Card className="rounded-3xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Por categoría</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading && <p className="text-xs text-muted-foreground">Cargando…</p>}
            {!loading && sortedCategories.length === 0 && (
              <EmptyHint>Sin gastos en este mes.</EmptyHint>
            )}
            {sortedCategories.map(({ cat, total }) => (
              <div key={cat?.id ?? "x"} className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground">
                      <CategoryIcon name={cat?.icon} className="size-3.5" />
                    </span>
                    <span className="font-medium">{cat?.name ?? "—"}</span>
                  </div>
                  <span className="tabular-nums">{formatCurrency(total)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-brand-grad transition-all"
                    style={{ width: max ? `${(total / max) * 100}%` : 0 }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-3xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Por cuenta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {sortedAccounts.length === 0 && <EmptyHint>Sin movimientos.</EmptyHint>}
            {sortedAccounts.map(({ acc, total }) => (
              <Link
                key={acc?.id ?? "x"}
                href={acc ? `/cuentas/${acc.id}` : "#"}
                className="flex items-center justify-between rounded-xl px-2 py-2.5 text-sm transition hover:bg-muted/60"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground">
                    <AccountIcon
                      name={acc?.icon ?? (acc ? defaultIconForType(acc.type) : undefined)}
                      className="size-3.5"
                    />
                  </span>
                  <span className="font-medium">{acc?.name ?? "—"}</span>
                </div>
                <span className="tabular-nums">{formatCurrency(total)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function BalancePill({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl bg-white/15 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider opacity-80">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{formatCurrency(value)}</div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}
