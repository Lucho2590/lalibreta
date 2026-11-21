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
import {
  useAccounts,
  useAllInstallments,
  useCategories,
  useInstallmentsForMonth,
  useSplitAdjustment,
} from "@/hooks/use-data";
import { useUsdRate } from "@/hooks/use-usd-rate";
import {
  computeMonthlyBalance,
  makeToARS,
  sumByAccount,
  sumByCategory,
} from "@/lib/domain/balance";
import { computeAccountBalances, totalAvailable } from "@/lib/domain/balances";
import { sortAccounts } from "@/lib/domain/accounts";
import { accountCurrencies, paymentMonthOf } from "@/lib/domain/types";
import { formatCurrency, formatMoney, formatMonth, formatShortDate } from "@/lib/format";
import { cardFloorMonth, summarizeCardMonth } from "@/lib/domain/card-summary";
import { monthUsdConversion } from "@/lib/domain/exchanges";
import { RecurringBanner } from "@/components/dashboard/recurring-banner";
import { ExchangeSummaryCard } from "@/components/transactions/exchange-summary-card";
import { ApprovalsBanner } from "@/components/dashboard/approvals-banner";
import { PendingInbox } from "@/components/people/pending-inbox";
import { isPersonAccountId } from "@/lib/domain/people";
import { TodayAgenda } from "@/components/dashboard/today-agenda";
import { WeatherCard } from "@/components/dashboard/weather-card";
import { Onboarding } from "@/components/dashboard/onboarding";
import { CategoryIcon } from "@/components/category-icon";
import { AccountIcon, defaultIconForType } from "@/components/account-icon";

export default function Dashboard() {
  const { monthKey, year, month } = useMonth();
  const { data: installments, loading } = useInstallmentsForMonth(monthKey);
  const { data: categories } = useCategories();
  const { data: accounts, loading: accountsLoading } = useAccounts();
  // Gastos repartidos: cuenta solo mi parte (y "si te pagan" lo que me deben los sin app).
  const adj = useSplitAdjustment();
  const adjProjected = useSplitAdjustment({ projected: true });

  const usdRate = useUsdRate();
  const { data: allInstallments } = useAllInstallments();

  const balance = useMemo(
    () => computeMonthlyBalance(installments, monthKey, adj, "ARS"),
    [installments, monthKey, adj],
  );
  const balanceUSD = useMemo(
    () => computeMonthlyBalance(installments, monthKey, adj, "USD"),
    [installments, monthKey, adj],
  );
  const hasUSD = balanceUSD.income !== 0 || balanceUSD.expense !== 0;
  // Gastos por categoría/cuenta en pesos: los US$ se convierten con el BCRA.
  const toARS = useMemo(() => makeToARS(usdRate?.rate), [usdRate]);
  const byCategory = useMemo(
    () => sumByCategory(installments, monthKey, adj, toARS),
    [installments, monthKey, adj, toARS],
  );
  const byAccount = useMemo(
    () => sumByAccount(installments, monthKey, adj, toARS),
    [installments, monthKey, adj, toARS],
  );

  // Saldos actuales de cada cuenta y deuda de tarjetas.
  const activeAccounts = useMemo(() => accounts.filter((a) => a.active !== false), [accounts]);
  const balances = useMemo(
    () => computeAccountBalances(activeAccounts, allInstallments),
    [activeAccounts, allInstallments],
  );
  const available = useMemo(() => totalAvailable(activeAccounts, balances), [activeAccounts, balances]);

  const sortedCategories = [...byCategory.entries()]
    .map(([id, total]) => ({ cat: categories.find((c) => c.id === id), total }))
    // Un reintegro de tarjeta con categoría de ingreso descuenta del total, pero
    // no se muestra como fila (quedaría un "Otros ingresos" negativo).
    .filter(({ cat, total }) => cat?.kind !== "income" && total > 0.009)
    .sort((a, b) => b.total - a.total);

  const sortedAccounts = [...byAccount.entries()]
    .map(([id, total]) => ({ id, acc: accounts.find((a) => a.id === id), total }))
    .sort((a, b) => b.total - a.total);

  const max = sortedCategories[0]?.total ?? 0;

  // Si hay dólares en el mes, el balance grande va todo en pesos: quien cobra en
  // dólares y los vende tiene "ingresos en pesos = 0" y el balance solo-pesos
  // siempre da negativo. Los dólares se pasan a la cotización a la que vendió
  // este mes (promedio); si no vendió, a la que compró; si no, el oficial BCRA.
  const conversion = useMemo(() => monthUsdConversion(installments, usdRate?.rate), [installments, usdRate]);
  const consolidated = hasUSD && conversion ? balance.balance + balanceUSD.balance * conversion.rate : null;
  const headline = consolidated ?? balance.balance;
  // "Si te pagan": como si la gente sin la app ya te hubiera devuelto su parte.
  const projBalance = useMemo(() => computeMonthlyBalance(installments, monthKey, adjProjected, "ARS"), [installments, monthKey, adjProjected]);
  const projBalanceUSD = useMemo(() => computeMonthlyBalance(installments, monthKey, adjProjected, "USD"), [installments, monthKey, adjProjected]);
  const projectedHeadline =
    hasUSD && conversion ? projBalance.balance + projBalanceUSD.balance * conversion.rate : projBalance.balance;
  const showProjected = Math.abs(projectedHeadline - headline) >= 1;
  const positive = headline >= 0;

  return (
    <div className="space-y-6">
      <div className="hidden md:flex md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inicio</h1>
          <p className="text-sm text-muted-foreground">{formatMonth(year, month)}</p>
        </div>
      </div>

      <Onboarding />

      {/* Sin cuentas no hay nada que mostrar: el onboarding ocupa el inicio. */}
      {(accountsLoading || accounts.length > 0) && (
        <>
          <ApprovalsBanner />
          <PendingInbox compact />
          <RecurringBanner />
          <WeatherCard />
          <TodayAgenda />

          <section className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2 overflow-hidden rounded-3xl bg-brand-grad p-6 text-white shadow-lg">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider opacity-80">
                {positive ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
                Balance del mes
              </div>
              <div className="mt-2 text-4xl font-bold tabular-nums md:text-5xl">
                {formatCurrency(headline)}
              </div>
              {showProjected && (
                <Link href="/compartidas" className="mt-1 inline-block rounded-full bg-white/15 px-3 py-1 text-xs font-medium hover:bg-white/25">
                  Si te pagan lo que te deben: <span className="tabular-nums">{formatCurrency(projectedHeadline)}</span>
                </Link>
              )}
              {consolidated != null ? (
                <div className="mt-1 text-sm tabular-nums opacity-90">
                  {formatMoney(balance.balance, "ARS")} en pesos {balanceUSD.balance >= 0 ? "+" : "−"}{" "}
                  {formatMoney(Math.abs(balanceUSD.balance), "USD")} en dólares
                </div>
              ) : (
                hasUSD && (
                  <div className="mt-1 text-xl font-semibold tabular-nums opacity-95">
                    {balanceUSD.balance >= 0 ? "+ " : ""}
                    {formatMoney(balanceUSD.balance, "USD")}
                  </div>
                )
              )}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <BalancePill
                  icon={<ArrowUpRight className="size-3.5" />}
                  label="Ingresos"
                  value={formatCurrency(balance.income)}
                  extra={hasUSD ? formatMoney(balanceUSD.income, "USD") : undefined}
                />
                <BalancePill
                  icon={<ArrowDownRight className="size-3.5" />}
                  label="Gastos"
                  value={formatCurrency(balance.expense)}
                  extra={hasUSD ? formatMoney(balanceUSD.expense, "USD") : undefined}
                />
              </div>
              {consolidated != null && conversion && (
                <div className="mt-3 text-xs opacity-80">
                  Todo en pesos, con el dólar a {formatCurrency(conversion.rate)} ({conversion.label}). Los
                  cambios de moneda y los pagos de tarjeta no son ingresos ni gastos: los consumos de la
                  tarjeta ya cuentan en el mes en que vence el resumen.
                </div>
              )}
            </div>

            <Card className="rounded-3xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Tus cuentas hoy</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 pt-1">
                {sortAccounts(activeAccounts.filter((a) => a.type !== "credit"))
                  .map((a) => {
                    const b = balances.get(a.id);
                    return (
                      <Link
                        key={a.id}
                        href={`/cuentas/${a.id}`}
                        className="flex items-start justify-between gap-2 text-sm hover:opacity-80"
                      >
                        <span className="truncate font-medium">
                          {a.isMain && <span title="Cuenta principal">⭐ </span>}
                          {a.type === "reserve" && <span title="Cobacha">🫙 </span>}
                          {a.name}
                        </span>
                        <span className="text-right tabular-nums">
                          {accountCurrencies(a).map((c) => (
                            <span key={c} className="block">
                              {formatMoney(b?.amounts[c] ?? 0, c)}
                            </span>
                          ))}
                        </span>
                      </Link>
                    );
                  })}
                {sortAccounts(activeAccounts.filter((a) => a.type === "credit"))
                  .map((a) => {
                    // Lo que falta pagar del resumen que vence este mes.
                    const s = summarizeCardMonth(allInstallments, [a.id], paymentMonthOf(new Date()), undefined, cardFloorMonth(a));
                    const owed = (["ARS", "USD"] as const).filter((c) => s.pending[c] > 0.009);
                    if (owed.length === 0) return null;
                    return (
                      <Link
                        key={a.id}
                        href={`/cuentas/${a.id}`}
                        className="flex items-start justify-between gap-2 text-sm text-muted-foreground hover:opacity-80"
                      >
                        <span className="truncate">
                          💳 {a.name}
                          {s.dueDate ? ` (vence ${formatShortDate(s.dueDate)})` : " (a pagar)"}
                        </span>
                        <span className="text-right tabular-nums">
                          {owed.map((c) => (
                            <span key={c} className="block">
                              {formatMoney(s.pending[c], c)}
                            </span>
                          ))}
                        </span>
                      </Link>
                    );
                  })}
                <div className="border-t pt-2.5 text-sm">
                  <div className="flex justify-between font-semibold">
                    <span>Disponible</span>
                    <span className="text-right tabular-nums">
                      <span className="block">{formatMoney(available.ARS, "ARS")}</span>
                      {available.USD !== 0 && (
                        <span className="block">{formatMoney(available.USD, "USD")}</span>
                      )}
                    </span>
                  </div>
                  {available.USD !== 0 && usdRate && (
                    <p className="mt-1 text-right text-xs text-muted-foreground">
                      ≈ {formatCurrency(available.ARS + available.USD * usdRate.rate)} en pesos
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Solo aparece si hubo cambios de dólares en el mes. */}
          <ExchangeSummaryCard installments={installments} maxItems={4} />

          <section className="grid gap-4 md:grid-cols-2">
            <Card className="rounded-3xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Por categoría</CardTitle>
                {hasUSD && usdRate && (
                  <p className="text-[11px] text-muted-foreground">En pesos (US$ al oficial BCRA)</p>
                )}
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
                {hasUSD && usdRate && (
                  <p className="text-[11px] text-muted-foreground">En pesos (US$ al oficial BCRA)</p>
                )}
              </CardHeader>
              <CardContent className="space-y-1">
                {sortedAccounts.length === 0 && <EmptyHint>Sin movimientos.</EmptyHint>}
                {sortedAccounts.map(({ id, acc, total }) => (
                  <Link
                    key={id}
                    href={acc ? `/cuentas/${acc.id}` : isPersonAccountId(id) ? "/compartidas" : "#"}
                    className="flex items-center justify-between rounded-xl px-2 py-2.5 text-sm transition hover:bg-muted/60"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground">
                        <AccountIcon
                          name={acc?.icon ?? (acc ? defaultIconForType(acc.type) : undefined)}
                          className="size-3.5"
                        />
                      </span>
                      <span className="font-medium">
                        {acc?.name ?? (isPersonAccountId(id) ? "Tu parte de gastos de otros" : "—")}
                      </span>
                    </div>
                    <span className="tabular-nums">{formatCurrency(total)}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

function BalancePill({
  icon,
  label,
  value,
  extra,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  extra?: string;
}) {
  return (
    <div className="rounded-2xl bg-white/15 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider opacity-80">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
      {extra && <div className="text-sm font-medium tabular-nums opacity-90">{extra}</div>}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}
