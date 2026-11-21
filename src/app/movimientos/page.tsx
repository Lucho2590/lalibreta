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
  useAllInstallments,
  useCategories,
  useInstallmentsForMonth,
  useSplitAdjustment,
} from "@/hooks/use-data";
import { TransactionList } from "@/components/transactions/transaction-list";
import { ExchangeSummaryCard } from "@/components/transactions/exchange-summary-card";
import { monthRates } from "@/lib/domain/exchanges";
import { useFxRates } from "@/hooks/use-fx-rates";
import { useNewTransactionSheet } from "@/components/transactions/new-transaction-sheet";
import { currencySymbol, formatCurrency, formatDate, formatMoney, formatMonth, moneyFormatter } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { CURRENCIES, FOREIGN_CURRENCIES, isCardCredit, isRealIncome, type Currency } from "@/lib/domain/types";
import { TAX_CATEGORY, cardFloorMonth, summarizeCardMonth } from "@/lib/domain/card-summary";

import { computeAccountFlow, computeMonthlyBalance, type AccountFlow } from "@/lib/domain/balance";

type MoneyMap = Partial<Record<Currency, number>>;

/** "$ 1.000 + US$ 20" con las monedas distintas de cero. */
const moneyText = (m: MoneyMap) =>
  CURRENCIES.filter((c) => m[c])
    .map((c) => formatMoney(m[c] as number, c))
    .join(" + ");

const anyNonZero = (m: MoneyMap) => CURRENCIES.some((c) => m[c]);

export default function MovimientosPage() {
  const params = useSearchParams();
  const accountFilter = params.get("account");
  const kindFilter = params.get("kind");
  const { monthKey, year, month } = useMonth();
  const { data: installments, loading, stale } = useInstallmentsForMonth(monthKey);
  // De qué mes son los movimientos que se están mostrando (al cambiar de mes,
  // hasta que llegan los nuevos, siguen siendo los del anterior).
  const dataMonth = stale ? (installments[0]?.paymentMonth ?? "anterior") : monthKey;
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const { open } = useNewTransactionSheet();
  // Gastos repartidos: cuenta solo mi parte.
  const adj = useSplitAdjustment();

  const filterAccount = accounts.find((a) => a.id === accountFilter);
  // Vista de tarjeta de crédito: gastos (con impuestos), reintegros y total a pagar.
  const isCardView = filterAccount?.type === "credit";

  const filtered = useMemo(() => {
    return installments.filter((i) => {
      if (accountFilter && i.accountId !== accountFilter) return false;
      if (kindFilter === "expense" && i.kind !== "expense") return false;
      if (kindFilter === "income" && !isRealIncome(i) && !(isCardView && isCardCredit(i))) return false;
      if (kindFilter === "transfer" && i.kind !== "transfer") return false;
      if (kindFilter === "exchange" && !(i.kind === "transfer" && i.transferType === "exchange")) return false;
      return true;
    });
  }, [installments, accountFilter, kindFilter, isCardView]);

  // Cambios de moneda: las dos patas de cada cambio (con filtro de cuenta, los
  // cambios en los que participa esa cuenta, de cualquier lado).
  const exchangeLegs = useMemo(() => {
    if (!accountFilter) return installments;
    const txIds = new Set(
      installments.filter((i) => i.accountId === accountFilter).map((i) => i.transactionId),
    );
    return installments.filter((i) => txIds.has(i.transactionId));
  }, [installments, accountFilter]);

  // Los totales de arriba respetan el filtro de cuenta (no el de tipo).
  const statBase = useMemo(
    () => (accountFilter ? installments.filter((i) => i.accountId === accountFilter) : installments),
    [installments, accountFilter],
  );
  const balance = useMemo(
    () => computeMonthlyBalance(statBase, monthKey, adj, "ARS"),
    [statBase, monthKey, adj],
  );

  const updateFilter = (key: string, value: string | null) => {
    const usp = new URLSearchParams(params.toString());
    if (value === null || value === "") usp.delete(key);
    else usp.set(key, value);
    const search = usp.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  };

  const foreign = useMemo(
    () =>
      FOREIGN_CURRENCIES.map((c) => ({ c, b: computeMonthlyBalance(statBase, monthKey, adj, c) })).filter(
        ({ b }) => b.income !== 0 || b.expense !== 0,
      ),
    [statBase, monthKey, adj],
  );
  const foreignMap = (pick: (b: (typeof foreign)[number]["b"]) => number): MoneyMap | undefined =>
    foreign.length ? Object.fromEntries(foreign.map(({ c, b }) => [c, pick(b)])) : undefined;
  // Balance "todo en pesos" (igual que el Inicio): quien cobra en dólares y los
  // vende tiene ingresos en pesos = 0 y el balance solo-pesos da siempre negativo.
  const fx = useFxRates();
  const conversion = useMemo(() => monthRates(installments, fx?.rates), [installments, fx]);
  const consolidated =
    foreign.length > 0 && foreign.every(({ c }) => conversion[c])
      ? balance.balance + foreign.reduce((s, { c, b }) => s + b.balance * (conversion[c]?.rate ?? 0), 0)
      : null;

  // Mirando UNA cuenta (no tarjeta), las transferencias y cambios sí cuentan:
  // lo que te pasaste desde otra cuenta entró a esta. En la vista general no,
  // porque mover plata entre cuentas propias no es ganar ni gastar.
  const flow = useMemo(() => {
    if (!accountFilter || isCardView) return null;
    const ids = new Set([accountFilter]);
    return Object.fromEntries(
      CURRENCIES.map((c) => [c, computeAccountFlow(installments, monthKey, ids, c)]),
    ) as Record<Currency, AccountFlow>;
  }, [accountFilter, isCardView, installments, monthKey]);
  const flowForeign = flow ? FOREIGN_CURRENCIES.filter((c) => flow[c].in !== 0 || flow[c].out !== 0) : [];
  const flowMap = (pick: (f: AccountFlow) => number): MoneyMap | undefined =>
    flow && flowForeign.length ? Object.fromEntries(flowForeign.map((c) => [c, pick(flow[c])])) : undefined;
  const transfersNote = (dir: "in" | "out") => {
    if (!flow) return undefined;
    const pick = (f: AccountFlow) => (dir === "in" ? f.transfersIn : f.transfersOut);
    const parts = moneyText(Object.fromEntries(CURRENCIES.map((c) => [c, pick(flow[c])])));
    if (!parts) return undefined;
    return dir === "in"
      ? `incluye ${parts} que pasaste desde otras cuentas`
      : `incluye ${parts} que pasaste a otras cuentas`;
  };

  const accountName = filterAccount?.name;
  const taxCategoryIds = useMemo(
    () => new Set(categories.filter((c) => TAX_CATEGORY.test(c.name)).map((c) => c.id)),
    [categories],
  );
  // Mismo cálculo que el detalle de la tarjeta: Total a pagar = gastos − reintegros.
  // Con todos los movimientos de la tarjeta, para repartir los pagos entre resúmenes
  // (un pago adelantado en otro mes cuenta para el resumen que corresponde).
  const { data: allInstallments } = useAllInstallments();
  const cardSum = useMemo(
    () =>
      isCardView && accountFilter && filterAccount
        ? summarizeCardMonth(allInstallments, [accountFilter], monthKey, taxCategoryIds, cardFloorMonth(filterAccount))
        : null,
    [isCardView, accountFilter, filterAccount, allInstallments, monthKey, taxCategoryIds],
  );
  const cardHasUSD = !!cardSum && (cardSum.expenses.USD !== 0 || cardSum.credits.USD !== 0);

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

      {/* Mientras llega el mes nuevo, lo del anterior queda atenuado. */}
      <div className={cn("transition-opacity duration-200", stale && "opacity-50")}>
      {cardSum ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Stat
            label="Gastos"
            value={cardSum.expenses.ARS}
            extra={cardHasUSD ? { USD: cardSum.expenses.USD } : undefined}
            note={
              anyNonZero(cardSum.taxes)
                ? `de impuestos y comisiones: ${moneyText(cardSum.taxes)}`
                : undefined
            }
            icon={<ArrowDownRight className="size-4" />}
          />
          <Stat
            label="Reintegros"
            value={cardSum.credits.ARS}
            extra={cardHasUSD ? { USD: cardSum.credits.USD } : undefined}
            tone={CURRENCIES.some((c) => cardSum.credits[c] > 0) ? "success" : undefined}
            note={
              !anyNonZero(cardSum.credits)
                ? "sin reintegros este mes"
                : "saldo a favor: se descuenta del total"
            }
            icon={<ArrowUpRight className="size-4" />}
          />
          <Stat
            label="Total a pagar"
            value={cardSum.total.ARS}
            extra={cardHasUSD ? { USD: cardSum.total.USD } : undefined}
            note={[
              cardSum.dueDate ? `vence el ${formatDate(cardSum.dueDate)}` : null,
              anyNonZero(cardSum.projected)
                ? `incluye ${moneyText(cardSum.projected)} estimado de suscripciones`
                : null,
              anyNonZero(cardSum.paid)
                ? anyNonZero(cardSum.pending)
                  ? `pagaste ${moneyText(cardSum.paid)}`
                  : "✓ pagado"
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined}
            emphasis
            icon={<Wallet className="size-4" />}
          />
        </div>
      ) : flow ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Stat
            label="Entradas"
            value={flow.ARS.in}
            extra={flowMap((f) => f.in)}
            tone="success"
            note={transfersNote("in")}
            icon={<ArrowUpRight className="size-4" />}
          />
          <Stat
            label="Salidas"
            value={flow.ARS.out}
            extra={flowMap((f) => f.out)}
            note={transfersNote("out")}
            icon={<ArrowDownRight className="size-4" />}
          />
          <Stat
            label="Neto del mes"
            value={flow.ARS.net}
            extra={flowMap((f) => f.net)}
            tone={CURRENCIES.every((c) => flow[c].net >= 0) ? "success" : "destructive"}
            icon={<Wallet className="size-4" />}
          />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          <Stat
            label="Ingresos"
            value={balance.income}
            extra={foreignMap((b) => b.income)}
            tone="success"
            icon={<ArrowUpRight className="size-4" />}
          />
          <Stat
            label="Gastos"
            value={balance.expense}
            extra={foreignMap((b) => b.expense)}
            icon={<ArrowDownRight className="size-4" />}
          />
          {consolidated != null ? (
            <Stat
              label="Balance"
              value={consolidated}
              tone={consolidated >= 0 ? "success" : "destructive"}
              note={`Todo en pesos: ${formatMoney(balance.balance, "ARS")}${foreign
                .map(({ c, b }) => ` ${b.balance >= 0 ? "+" : "−"} ${formatMoney(Math.abs(b.balance), c)}`)
                .join("")}, con ${foreign
                .map(({ c }) => `${currencySymbol(c)} 1 = ${formatMoney(conversion[c]?.rate ?? 0, "ARS")} (${conversion[c]?.label})`)
                .join(", ")}.`}
              icon={<Wallet className="size-4" />}
            />
          ) : (
            <Stat
              label="Balance"
              value={balance.balance}
              extra={foreignMap((b) => b.balance)}
              tone={balance.balance >= 0 ? "success" : "destructive"}
              icon={<Wallet className="size-4" />}
            />
          )}
        </div>
      )}
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
            <TabsTrigger value="exchange">Cambios</TabsTrigger>
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

      {/* Cambios de moneda: resumen del mes (cuánto vendió/compró y a qué promedio). */}
      {!loading && !isCardView && (kindFilter === "exchange" || kindFilter === "transfer") && (
        <ExchangeSummaryCard
          installments={exchangeLegs}
          showList={false}
          showEmpty={kindFilter === "exchange"}
        />
      )}

      {loading ? (
        <SkeletonList />
      ) : (
        // Al llegar los movimientos de otro mes (o al cambiar de filtro) la lista
        // se vuelve a montar y las filas entran en cascada; mientras llega el mes
        // nuevo, los del anterior quedan atenuados (sin saltos).
        <div
          key={`${dataMonth}|${kindFilter ?? "all"}|${accountFilter ?? ""}`}
          className={cn("transition-opacity duration-200", stale && "opacity-50")}
        >
          {filtered.length === 0 ? (
            <Card className="rounded-3xl">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                Sin movimientos en este mes.
              </CardContent>
            </Card>
          ) : (
            <TransactionList
              items={filtered}
              perspectiveAccountId={isCardView ? undefined : (accountFilter ?? undefined)}
              groupCards={!isCardView}
              adjustment={adj}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  extra,
  tone,
  icon,
  note,
  emphasis,
}: {
  label: string;
  value: number;
  /** Lo mismo en otras monedas (dólares, euros…). */
  extra?: MoneyMap;
  tone?: "success" | "destructive";
  icon?: React.ReactNode;
  /** Línea chica debajo (ej. impuestos, vencimiento). */
  note?: string;
  /** Resalta la tarjeta (ej. Total a pagar). */
  emphasis?: boolean;
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "";
  return (
    <Card className={`rounded-2xl ${emphasis ? "ring-2 ring-brand/30" : ""}`}>
      <CardContent className="py-4">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>
          <AnimatedNumber value={value} format={formatCurrency} />
        </div>
        {Object.entries(extra ?? {}).map(([c, v]) => (
          <div key={c} className={`text-sm font-medium tabular-nums ${toneClass}`}>
            <AnimatedNumber value={v ?? 0} format={moneyFormatter(c as Currency)} />
          </div>
        ))}
        {note && (
          <div className="mt-1.5 text-xs text-muted-foreground">{note}</div>
        )}
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
