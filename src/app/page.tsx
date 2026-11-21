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
import { useFxRates } from "@/hooks/use-fx-rates";
import {
  computeMonthlyBalance,
  makeToARS,
  sumInARS,
  unconvertedCurrencies,
  sumByAccount,
  sumByCategory,
} from "@/lib/domain/balance";
import { computeAccountBalances, totalAvailable } from "@/lib/domain/balances";
import { sortAccounts } from "@/lib/domain/accounts";
import { CARD_CURRENCIES, FOREIGN_CURRENCIES, accountCurrencies, paymentMonthOf, type Currency } from "@/lib/domain/types";
import { currencyLabel, currencySymbol, formatCurrency, formatMoney, formatMonth, formatShortDate, moneyFormatter } from "@/lib/format";
import { cardFloorMonth, summarizeCardMonth } from "@/lib/domain/card-summary";
import { monthRates } from "@/lib/domain/exchanges";
import { ExchangeSummaryCard } from "@/components/transactions/exchange-summary-card";
import { isPersonAccountId } from "@/lib/domain/people";
import { HomeShortcuts } from "@/components/dashboard/home-shortcuts";
import { Onboarding } from "@/components/dashboard/onboarding";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { ENTER, enterDelay } from "@/components/motion/enter";
import { cn } from "@/lib/utils";
import { CategoryIcon } from "@/components/category-icon";
import { AccountIcon, defaultIconForType } from "@/components/account-icon";

export default function Dashboard() {
  const { monthKey, year, month } = useMonth();
  const { data: installments, loading, stale } = useInstallmentsForMonth(monthKey);
  const { data: categories, loading: categoriesLoading } = useCategories();
  const { data: accounts, loading: accountsLoading } = useAccounts();
  // Gastos repartidos: cuenta solo mi parte (y "si te pagan" lo que me deben los sin app).
  const adj = useSplitAdjustment();
  const adjProjected = useSplitAdjustment({ projected: true });

  const fx = useFxRates();
  const { data: allInstallments } = useAllInstallments();

  const balance = useMemo(
    () => computeMonthlyBalance(installments, monthKey, adj, "ARS"),
    [installments, monthKey, adj],
  );
  // Monedas extranjeras con movimientos en el mes (dólares, euros…).
  const foreign = useMemo(
    () =>
      FOREIGN_CURRENCIES.map((c) => ({ c, b: computeMonthlyBalance(installments, monthKey, adj, c) })).filter(
        ({ b }) => b.income !== 0 || b.expense !== 0,
      ),
    [installments, monthKey, adj],
  );
  const hasForeign = foreign.length > 0;
  // Gastos por categoría/cuenta en pesos: las otras monedas se convierten con el BCRA.
  const toARS = useMemo(() => makeToARS(fx?.rates), [fx]);
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

  const sortedCategories = useMemo(() => {
    // Hasta que cargan las categorías no se muestra nada (si no, todas las
    // filas salían como "—").
    if (categoriesLoading) return [];
    const catById = new Map(categories.map((c) => [c.id, c]));
    // Las que no están en sus categorías (borradas, o de una cuenta compartida
    // de otra persona) van juntas en una sola fila.
    let unknown = 0;
    const rows: Array<{ id: string; cat: (typeof categories)[number] | undefined; total: number }> = [];
    for (const [id, total] of byCategory) {
      const cat = catById.get(id);
      if (cat) rows.push({ id, cat, total });
      else unknown += total;
    }
    if (unknown > 0.009) rows.push({ id: "__sin-categoria", cat: undefined, total: unknown });
    return (
      rows
        // Un reintegro de tarjeta con categoría de ingreso descuenta del total, pero
        // no se muestra como fila (quedaría un "Otros ingresos" negativo).
        .filter(({ cat, total }) => cat?.kind !== "income" && total > 0.009)
        .sort((a, b) => b.total - a.total)
    );
  }, [byCategory, categories, categoriesLoading]);

  const sortedAccounts = [...byAccount.entries()]
    .map(([id, total]) => ({ id, acc: accounts.find((a) => a.id === id), total }))
    .sort((a, b) => b.total - a.total);

  const max = sortedCategories[0]?.total ?? 0;

  // Si hay dólares en el mes, el balance grande va todo en pesos: quien cobra en
  // dólares y los vende tiene "ingresos en pesos = 0" y el balance solo-pesos
  // siempre da negativo. Los dólares se pasan a la cotización a la que vendió
  // este mes (promedio); si no vendió, a la que compró; si no, el oficial BCRA.
  const conversion = useMemo(() => monthRates(installments, fx?.rates), [installments, fx]);
  // Solo se consolida si todas las monedas del mes tienen cotización.
  const canConsolidate = hasForeign && foreign.every(({ c }) => conversion[c]);
  const consolidated = canConsolidate
    ? balance.balance + foreign.reduce((s, { c, b }) => s + b.balance * (conversion[c]?.rate ?? 0), 0)
    : null;
  const headline = consolidated ?? balance.balance;
  // "Si te pagan": como si la gente sin la app ya te hubiera devuelto su parte.
  const projected = useMemo(() => {
    const ars = computeMonthlyBalance(installments, monthKey, adjProjected, "ARS").balance;
    if (!canConsolidate) return ars;
    return foreign.reduce(
      (s, { c }) =>
        s + computeMonthlyBalance(installments, monthKey, adjProjected, c).balance * (conversion[c]?.rate ?? 0),
      ars,
    );
  }, [installments, monthKey, adjProjected, canConsolidate, foreign, conversion]);
  const projectedHeadline = projected;
  const foreignIncome = Object.fromEntries(foreign.map(({ c, b }) => [c, b.income])) as Partial<Record<Currency, number>>;
  const foreignExpense = Object.fromEntries(foreign.map(({ c, b }) => [c, b.expense])) as Partial<Record<Currency, number>>;
  const availableMissing = unconvertedCurrencies(available, fx?.rates);
  const availableHasForeign = FOREIGN_CURRENCIES.some((c) => available[c] !== 0);
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
          {/* Fijos, pendientes, agenda y clima: íconos que abren su tarjeta. */}
          <HomeShortcuts />

          <section className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2 overflow-hidden rounded-3xl bg-brand-grad p-6 text-white shadow-lg">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider opacity-80">
                {positive ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
                Balance del mes
              </div>
              <div className="mt-2 text-4xl font-bold tabular-nums md:text-5xl">
                <AnimatedNumber value={headline} format={formatCurrency} />
              </div>
              {showProjected && (
                <Link href="/compartidas" className="mt-1 inline-block rounded-full bg-white/15 px-3 py-1 text-xs font-medium hover:bg-white/25">
                  Si te pagan lo que te deben:{" "}
                  <AnimatedNumber className="tabular-nums" value={projectedHeadline} format={formatCurrency} />
                </Link>
              )}
              {consolidated != null ? (
                <div className="mt-1 text-sm tabular-nums opacity-90">
                  <AnimatedNumber value={balance.balance} format={formatCurrency} /> en pesos
                  {foreign.map(({ c, b }) => (
                    <span key={c}>
                      {" "}
                      {b.balance >= 0 ? "+" : "−"}{" "}
                      <AnimatedNumber value={Math.abs(b.balance)} format={moneyFormatter(c)} /> en{" "}
                      {currencyLabel(c).toLowerCase()}
                    </span>
                  ))}
                </div>
              ) : (
                foreign.map(({ c, b }) => (
                  <div key={c} className="mt-1 text-xl font-semibold tabular-nums opacity-95">
                    {b.balance >= 0 ? "+ " : ""}
                    <AnimatedNumber value={b.balance} format={moneyFormatter(c)} />
                  </div>
                ))
              )}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <BalancePill
                  icon={<ArrowUpRight className="size-3.5" />}
                  label="Ingresos"
                  value={balance.income}
                  extra={foreignIncome}
                />
                <BalancePill
                  icon={<ArrowDownRight className="size-3.5" />}
                  label="Gastos"
                  value={balance.expense}
                  extra={foreignExpense}
                />
              </div>
              {consolidated != null && (
                <div className="mt-3 text-xs opacity-80">
                  Todo en pesos, con{" "}
                  {foreign
                    .map(({ c }) => {
                      const r = conversion[c];
                      return r ? `${currencySymbol(c)} 1 = ${formatCurrency(r.rate)} (${r.label})` : "";
                    })
                    .join(", ")}
                  . Los
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
                    const owed = CARD_CURRENCIES.filter((c) => s.pending[c] > 0.009);
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
                      {FOREIGN_CURRENCIES.filter((c) => available[c] !== 0).map((c) => (
                        <span key={c} className="block">
                          {formatMoney(available[c], c)}
                        </span>
                      ))}
                    </span>
                  </div>
                  {availableHasForeign && fx && availableMissing.length === 0 && (
                    <p className="mt-1 text-right text-xs text-muted-foreground">
                      ≈ {formatCurrency(sumInARS(available, fx.rates))} en pesos
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Solo aparece si hubo cambios de moneda en el mes. */}
          <ExchangeSummaryCard installments={installments} maxItems={4} />

          {/* Mientras llega el mes nuevo, lo del anterior queda atenuado. */}
          <section className={cn("grid gap-4 transition-opacity duration-200 md:grid-cols-2", stale && "opacity-50")}>
            <Card className="rounded-3xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Por categoría</CardTitle>
                {hasForeign && fx && (
                  <p className="text-[11px] text-muted-foreground">En pesos (otras monedas al oficial BCRA)</p>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {loading && <p className="text-xs text-muted-foreground">Cargando…</p>}
                {!loading && sortedCategories.length === 0 && (
                  <EmptyHint>Sin gastos en este mes.</EmptyHint>
                )}
                {sortedCategories.map(({ id, cat, total }, i) => (
                  <div key={id} className={cn("space-y-1.5", ENTER)} style={enterDelay(i)}>
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground">
                          <CategoryIcon name={cat?.icon} className="size-3.5" />
                        </span>
                        <span className="font-medium">{cat?.name ?? "Sin categoría"}</span>
                      </div>
                      <AnimatedNumber className="tabular-nums" value={total} format={formatCurrency} />
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-brand-grad transition-[width] duration-700 ease-out motion-reduce:transition-none"
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
                {hasForeign && fx && (
                  <p className="text-[11px] text-muted-foreground">En pesos (otras monedas al oficial BCRA)</p>
                )}
              </CardHeader>
              <CardContent className="space-y-1">
                {sortedAccounts.length === 0 && <EmptyHint>Sin movimientos.</EmptyHint>}
                {sortedAccounts.map(({ id, acc, total }, i) => (
                  <Link
                    key={id}
                    href={acc ? `/cuentas/${acc.id}` : isPersonAccountId(id) ? "/compartidas" : "#"}
                    className={cn(
                      "flex items-center justify-between rounded-xl px-2 py-2.5 text-sm transition hover:bg-muted/60",
                      ENTER,
                    )}
                    style={enterDelay(i)}
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
                    <AnimatedNumber className="tabular-nums" value={total} format={formatCurrency} />
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
  value: number;
  /** Lo mismo en otras monedas (dólares, euros…). */
  extra?: Partial<Record<Currency, number>>;
}) {
  return (
    <div className="rounded-2xl bg-white/15 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider opacity-80">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">
        <AnimatedNumber value={value} format={formatCurrency} />
      </div>
      {Object.entries(extra ?? {}).map(([c, v]) => (
        <div key={c} className="text-sm font-medium tabular-nums opacity-90">
          <AnimatedNumber value={v ?? 0} format={moneyFormatter(c as Currency)} />
        </div>
      ))}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}
