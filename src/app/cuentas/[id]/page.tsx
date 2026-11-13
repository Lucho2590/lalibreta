"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AccountIcon, defaultIconForType } from "@/components/account-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  useAccounts,
  useAllInstallments,
  useSharedAsOwner,
} from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { useMonth } from "@/hooks/use-month";
import { CardCycleEditor } from "@/components/accounts/card-cycle-editor";
import { ShareAccountSection } from "@/components/accounts/share-account-section";
import { formatMoney, formatMonth } from "@/lib/format";
import type { AccountType, Currency } from "@/lib/domain/types";
import { accountCurrencies, currencyOf } from "@/lib/domain/types";
import { computeAccountBalances } from "@/lib/domain/balances";
import {
  buildSharedByTxId,
  getEffectiveInstallmentInfo,
} from "@/lib/domain/shared-effective";
import { useMemo } from "react";

const typeLabel: Record<AccountType, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Tarjeta de crédito",
  checking: "Cuenta corriente",
  savings: "Caja de ahorro",
  digital: "Billetera virtual",
  reserve: "Cobacha",
};

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: installments } = useAllInstallments();
  const { data: shared } = useSharedAsOwner();
  const { monthKey, year, month } = useMonth();
  const sharedByTxId = useMemo(() => buildSharedByTxId(shared), [shared]);
  const effectiveAmount = (i: (typeof installments)[number]) =>
    user
      ? getEffectiveInstallmentInfo(i, sharedByTxId, user.uid).effectiveAmount
      : i.amount;

  const account = accounts.find((a) => a.id === id);
  if (!account) {
    return (
      <div className="space-y-3">
        <Link href="/cuentas" className="inline-flex items-center text-sm text-muted-foreground">
          <ArrowLeft className="mr-1 size-4" /> Volver
        </Link>
        <p className="text-sm">Cuenta no encontrada.</p>
      </div>
    );
  }

  const parent = account.parentId
    ? accounts.find((a) => a.id === account.parentId)
    : null;
  const children = accounts.filter((a) => a.parentId === account.id);
  const childIds = new Set([account.id, ...children.map((c) => c.id)]);

  const monthly = installments.filter(
    (i) => childIds.has(i.accountId) && i.billingMonth === monthKey,
  );
  // El total muestra solamente gastos (los ingresos y transferencias se ven aparte).
  const totals: Record<Currency, number> = { ARS: 0, USD: 0 };
  for (const i of monthly) {
    if (i.kind === "expense") totals[currencyOf(i)] += effectiveAmount(i);
  }
  const totalCurrencies = (["ARS", "USD"] as Currency[]).filter(
    (c) => c === "ARS" || totals[c] !== 0,
  );
  // Saldo de hoy (cuentas) o lo que se debe (tarjetas).
  const balance = computeAccountBalances([account], installments).get(account.id)?.amounts ?? {
    ARS: 0,
    USD: 0,
  };
  const balanceCurrencies: Currency[] =
    account.type === "credit"
      ? (["ARS", "USD"] as Currency[]).filter((c) => c === "ARS" || balance[c] !== 0)
      : accountCurrencies(account);

  return (
    <div className="space-y-6">
      <Link
        href="/cuentas"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" /> Cuentas
      </Link>

      {parent && (
        <Link
          href={`/cuentas/${parent.id}`}
          className="-mt-3 inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Parte de {parent.name}
        </Link>
      )}

      <div className="overflow-hidden rounded-3xl bg-brand-grad p-6 text-white shadow-lg">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <AccountIcon
              name={account.icon ?? defaultIconForType(account.type)}
              className="size-5"
            />
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider opacity-80">
              {typeLabel[account.type]}
            </div>
            <div className="text-xl font-bold tracking-tight">{account.name}</div>
          </div>
        </div>
        <div className="mt-6">
          <div className="text-[11px] uppercase tracking-wider opacity-80">
            Gastos {formatMonth(year, month)}
            {children.length > 0 ? " · incluye tarjetas asociadas" : ""}
          </div>
          <div className="text-3xl font-bold tabular-nums md:text-4xl">
            {totalCurrencies.map((c) => (
              <div key={c}>{formatMoney(totals[c], c)}</div>
            ))}
          </div>
          <div className="mt-1 text-xs opacity-80">
            {monthly.length} {monthly.length === 1 ? "movimiento" : "movimientos"}
          </div>
          <div className="mt-4 rounded-2xl bg-white/15 px-4 py-3 backdrop-blur">
            <div className="text-[11px] uppercase tracking-wider opacity-80">
              {account.type === "credit" ? "A pagar" : "Saldo hoy"}
              {account.isMain ? " · ⭐ cuenta principal" : ""}
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {balanceCurrencies.map((c) => formatMoney(balance[c], c)).join("  ·  ")}
            </div>
          </div>
        </div>
      </div>

      {children.length > 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-4">
            <div className="text-sm font-semibold">
              {children.every((c) => c.type === "reserve")
                ? "Cobachas"
                : children.some((c) => c.type === "reserve")
                  ? "Tarjetas y cobachas"
                  : "Tarjetas asociadas"}
            </div>
            <div className="mt-3 space-y-2">
              {children.map((card) => {
                const isReserveChild = card.type === "reserve";
                const childBal = isReserveChild
                  ? computeAccountBalances([card], installments).get(card.id)?.amounts
                  : undefined;
                const cardTotals: Record<Currency, number> = { ARS: 0, USD: 0 };
                for (const i of installments) {
                  if (i.accountId === card.id && i.billingMonth === monthKey && i.kind === "expense") {
                    cardTotals[currencyOf(i)] += effectiveAmount(i);
                  }
                }
                return (
                  <Link
                    key={card.id}
                    href={`/cuentas/${card.id}`}
                    className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-muted/60"
                  >
                    <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground">
                      <AccountIcon
                        name={card.icon ?? defaultIconForType(card.type)}
                        className="size-4"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{card.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {isReserveChild
                          ? "Cobacha · saldo"
                          : `Cierre día ${card.defaultClosingDay ?? "—"} · gastos del mes`}
                      </div>
                    </div>
                    <div className="text-sm font-semibold tabular-nums">
                      {isReserveChild && childBal ? (
                        accountCurrencies(card).map((c) => (
                          <span key={c} className="block">
                            {formatMoney(childBal[c], c)}
                          </span>
                        ))
                      ) : (
                        <>
                          {formatMoney(cardTotals.ARS, "ARS")}
                          {cardTotals.USD !== 0 && (
                            <span className="block text-xs">{formatMoney(cardTotals.USD, "USD")}</span>
                          )}
                        </>
                      )}
                    </div>
                    <ArrowRight className="size-4 text-muted-foreground" />
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <ShareAccountSection account={account} />

      <div className="grid gap-4 md:grid-cols-2">
        {account.type === "credit" && <CardCycleEditor account={account} />}

        <Card className="rounded-3xl">
          <CardContent className="py-4">
            <div className="text-sm font-semibold">Movimientos del mes</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Mirá el detalle filtrado por esta cuenta
              {children.length > 0 ? " (sin las tarjetas asociadas)" : ""}.
            </p>
            <Button
              variant="outline"
              className="mt-3 w-full"
              nativeButton={false}
              render={<Link href={`/movimientos?account=${account.id}`} />}
            >
              Ver movimientos <ArrowRight className="ml-1 size-4" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
