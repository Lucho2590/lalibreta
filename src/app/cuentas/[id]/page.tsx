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
  useCategories,
  useSharedAsOwner,
} from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { useMonth } from "@/hooks/use-month";
import { CardCycleEditor } from "@/components/accounts/card-cycle-editor";
import { ShareAccountSection } from "@/components/accounts/share-account-section";
import { formatDate, formatMoney, formatMonth } from "@/lib/format";
import { TAX_CATEGORY, nextMonthKey, summarizeCardMonth, type Money } from "@/lib/domain/card-summary";
import type { AccountType, Currency } from "@/lib/domain/types";
import { accountCurrencies, currencyOf, monthOf } from "@/lib/domain/types";
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
  const { data: categories } = useCategories();
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
    (i) => childIds.has(i.accountId) && monthOf(i) === monthKey,
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

  // Tarjeta: resumen del mes de pago elegido (igual al "Total a pagar" del banco)
  // y lo que va juntando el resumen siguiente.
  const taxIds = new Set(categories.filter((c) => TAX_CATEGORY.test(c.name)).map((c) => c.id));
  const card = summarizeCardMonth(installments, [account.id], monthKey, taxIds);
  const nextKey = nextMonthKey(monthKey);
  const nextCard = summarizeCardMonth(installments, [account.id], nextKey, taxIds);
  const [nextY, nextM] = nextKey.split("-").map(Number);

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
        {account.type === "credit" ? (
          <div className="mt-6 space-y-3">
            <div className="text-[11px] uppercase tracking-wider opacity-80">
              Resumen que vence en {formatMonth(year, month)}
              {card.dueDate ? ` · vence el ${formatDate(card.dueDate)}` : ""}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <HeroStat
                label="Gastos"
                money={card.expenses}
                note={
                  card.taxes.ARS || card.taxes.USD
                    ? `de impuestos y comisiones: ${moneyText(card.taxes)}`
                    : undefined
                }
              />
              <HeroStat
                label="Reintegros"
                money={card.credits}
                note={card.credits.ARS || card.credits.USD ? "saldo a favor" : "sin reintegros"}
              />
              <HeroStat
                label="Total a pagar"
                money={card.total}
                emphasis
                note={
                  card.paid.ARS || card.paid.USD
                    ? card.pending.ARS || card.pending.USD
                      ? `pagaste ${moneyText(card.paid)} · faltan ${moneyText(card.pending)}`
                      : "✓ pagado"
                    : undefined
                }
              />
            </div>
            {(nextCard.total.ARS !== 0 || nextCard.total.USD !== 0) && (
              <div className="rounded-2xl bg-white/10 px-4 py-2.5 text-sm">
                <span className="opacity-80">Próximo resumen (vence en {formatMonth(nextY, nextM)}): </span>
                <span className="font-semibold tabular-nums">{moneyText(nextCard.total)}</span>
                <span className="opacity-80">
                  {" "}
                  hasta ahora
                  {nextCard.projected.ARS || nextCard.projected.USD
                    ? ` · incluye ${moneyText(nextCard.projected)} estimado de suscripciones`
                    : ""}
                </span>
              </div>
            )}
          </div>
        ) : (
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
                Saldo hoy
                {account.isMain ? " · ⭐ cuenta principal" : ""}
              </div>
              <div className="text-lg font-semibold tabular-nums">
                {balanceCurrencies.map((c) => formatMoney(balance[c], c)).join("  ·  ")}
              </div>
            </div>
          </div>
        )}
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
                  if (i.accountId === card.id && monthOf(i) === monthKey && i.kind === "expense") {
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

        {account.type === "credit" && (
          <Card className="hidden rounded-3xl md:block">
            <CardContent className="py-4">
              <div className="text-sm font-semibold">Importar resumen</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Subí el PDF del resumen: carga los consumos con su categoría y no duplica lo que ya
                tenías.
              </p>
              <Button
                variant="outline"
                className="mt-3 w-full"
                nativeButton={false}
                render={<Link href={`/resumenes?account=${account.id}`} />}
              >
                Importar resumen <ArrowRight className="ml-1 size-4" />
              </Button>
            </CardContent>
          </Card>
        )}

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

const moneyText = (m: Money) =>
  [m.ARS ? formatMoney(m.ARS, "ARS") : null, m.USD ? formatMoney(m.USD, "USD") : null]
    .filter(Boolean)
    .join(" + ") || formatMoney(0, "ARS");

function HeroStat({
  label,
  money,
  note,
  emphasis,
}: {
  label: string;
  money: Money;
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`rounded-2xl px-4 py-3 backdrop-blur ${emphasis ? "bg-white/25 ring-1 ring-white/40" : "bg-white/15"}`}>
      <div className="text-[11px] uppercase tracking-wider opacity-80">{label}</div>
      <div className={`font-bold tabular-nums ${emphasis ? "text-2xl" : "text-xl"}`}>
        {formatMoney(money.ARS, "ARS")}
      </div>
      {money.USD !== 0 && <div className="text-sm font-semibold tabular-nums">{formatMoney(money.USD, "USD")}</div>}
      {note && <div className="mt-1 text-xs opacity-80">{note}</div>}
    </div>
  );
}
