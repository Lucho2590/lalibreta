"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowLeftRight, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAccounts, useCategories } from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { deleteTransactionAndInstallments } from "@/lib/domain/installments";
import type { Installment, SharedExpense } from "@/lib/domain/types";
import { formatMoney, formatShortDate } from "@/lib/format";
import { currencyOf } from "@/lib/domain/types";
import { CategoryIcon } from "@/components/category-icon";
import { getEffectiveInstallmentInfo } from "@/lib/domain/shared-effective";

interface Props {
  items: Installment[];
  sharedByTxId?: Map<string, SharedExpense>;
  ownerUid?: string;
}

export function TransactionList({ items, sharedByTxId, ownerUid }: Props) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const remove = async (transactionId: string) => {
    if (!user) return;
    if (!confirm("¿Eliminar este movimiento?")) return;
    try {
      await deleteTransactionAndInstallments(user.uid, transactionId);
      toast.success("Eliminado");
    } catch (err) {
      toast.error("No se pudo eliminar");
      console.error(err);
    }
  };

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Sin movimientos en este mes.
        </CardContent>
      </Card>
    );
  }

  // Transferencias: una sola entrada por transacción (la de origen si está;
  // si la lista es de la cuenta destino, la de destino). Guardamos la otra pata
  // para mostrar los cambios de moneda (US$ 500 → $ 740.000).
  const legsByTx = new Map<string, typeof items>();
  for (const i of items) {
    if (i.kind !== "transfer") continue;
    legsByTx.set(i.transactionId, [...(legsByTx.get(i.transactionId) ?? []), i]);
  }
  const dedup = items.filter((i) => {
    if (i.kind !== "transfer") return true;
    const legs = legsByTx.get(i.transactionId) ?? [];
    return i.transferRole === "source" || !legs.some((l) => l.transferRole === "source");
  });
  const sorted = [...dedup].sort(
    (a, b) => b.billingDate.toMillis() - a.billingDate.toMillis(),
  );

  const effectiveOwner = ownerUid ?? user?.uid ?? "";
  const shareIndex = sharedByTxId;

  return (
    <div className="space-y-2">
      {sorted.map((it) => {
        const acc = accountMap.get(it.accountId);
        const cat = categoryMap.get(it.categoryId);
        const isTransfer = it.kind === "transfer";
        const counterpart = isTransfer
          ? accountMap.get(it.transferCounterpartId ?? "")
          : null;
        const cur = currencyOf(it);
        const otherLeg = isTransfer
          ? legsByTx.get(it.transactionId)?.find((l) => l.id !== it.id)
          : undefined;
        const isExchange = it.transferType === "exchange" || (otherLeg && currencyOf(otherLeg) !== cur);
        const isCardPayment = it.transferType === "card-payment";
        const transferLabel = isCardPayment ? "Pago de tarjeta" : isExchange ? "Cambio" : "Transferencia";
        const [fromName, toName] =
          it.transferRole === "destination"
            ? [counterpart?.name, acc?.name]
            : [acc?.name, counterpart?.name];

        const shareInfo =
          shareIndex && effectiveOwner && it.kind === "expense"
            ? getEffectiveInstallmentInfo(it, shareIndex, effectiveOwner)
            : null;
        const isShared = shareInfo?.isShared ?? false;
        const displayAmount = isShared ? shareInfo!.effectiveAmount : it.amount;
        const showDiff =
          isShared && shareInfo!.effectiveAmount !== shareInfo!.totalAmount;

        return (
          <Card key={it.id} className="rounded-2xl transition hover:shadow-sm">
            <CardContent className="flex items-center gap-3 py-3.5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                {isTransfer ? (
                  <ArrowLeftRight className="size-5" />
                ) : (
                  <CategoryIcon name={cat?.icon} className="size-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {it.description ||
                      (isTransfer
                        ? transferLabel
                        : cat?.name || "Movimiento")}
                  </span>
                  {isTransfer && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {transferLabel}
                    </span>
                  )}
                  {it.createdByName && (
                    <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                      {it.createdByName}
                    </span>
                  )}
                  {!isTransfer && it.totalInstallments > 1 && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {it.installmentNumber}/{it.totalInstallments}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {isTransfer
                    ? `${fromName === toName ? (fromName ?? "—") : `${fromName ?? "—"} → ${toName ?? "—"}`} · ${formatShortDate(it.billingDate.toDate())}`
                    : `${cat?.name ?? "—"} · ${acc?.name ?? "—"} · ${formatShortDate(it.billingDate.toDate())}`}
                </div>
                {isShared && shareInfo?.shared && (
                  <Link
                    href={`/compartidas/${shareInfo.shared.id}`}
                    className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/20"
                  >
                    <Users className="size-3" />
                    Compartido · total {formatMoney(shareInfo.totalAmount, cur)}
                    {shareInfo.othersCount > 0 &&
                      ` · ${shareInfo.acceptedCount}/${shareInfo.othersCount} aceptaron`}
                  </Link>
                )}
              </div>
              <div className="flex flex-col items-end">
                <div
                  className={`text-sm font-semibold tabular-nums ${
                    it.kind === "income"
                      ? "text-success"
                      : isTransfer
                        ? "text-muted-foreground"
                        : ""
                  }`}
                >
                  {isTransfer
                    ? isExchange && otherLeg
                      ? `${formatMoney(it.transferRole === "destination" ? otherLeg.amount : it.amount, it.transferRole === "destination" ? currencyOf(otherLeg) : cur)} → ${formatMoney(it.transferRole === "destination" ? it.amount : otherLeg.amount, it.transferRole === "destination" ? cur : currencyOf(otherLeg))}`
                      : formatMoney(it.amount, cur)
                    : it.kind === "income"
                      ? `+${formatMoney(displayAmount, cur)}`
                      : `-${formatMoney(displayAmount, cur)}`}
                </div>
                {showDiff && (
                  <div className="text-[10px] text-muted-foreground line-through tabular-nums">
                    {formatMoney(shareInfo!.totalAmount, cur)}
                  </div>
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => remove(it.transactionId)}
                aria-label="Eliminar"
              >
                <Trash2 className="size-4" />
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
