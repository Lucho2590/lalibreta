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
import { formatCurrency, formatShortDate } from "@/lib/format";
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

  // Para transferencias mostramos sólo una entrada (la del origen) — la del destino
  // duplicaría visualmente el movimiento.
  const dedup = items.filter(
    (i) => i.kind !== "transfer" || i.transferRole === "source",
  );
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
                        ? "Transferencia"
                        : cat?.name || "Movimiento")}
                  </span>
                  {isTransfer && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Transferencia
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
                    ? `${acc?.name ?? "—"} → ${counterpart?.name ?? "—"} · ${formatShortDate(it.billingDate.toDate())}`
                    : `${cat?.name ?? "—"} · ${acc?.name ?? "—"} · ${formatShortDate(it.billingDate.toDate())}`}
                </div>
                {isShared && shareInfo?.shared && (
                  <Link
                    href={`/compartidas/${shareInfo.shared.id}`}
                    className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/20"
                  >
                    <Users className="size-3" />
                    Compartido · total {formatCurrency(shareInfo.totalAmount)}
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
                    ? formatCurrency(it.amount)
                    : it.kind === "income"
                      ? `+${formatCurrency(displayAmount)}`
                      : `-${formatCurrency(displayAmount)}`}
                </div>
                {showDiff && (
                  <div className="text-[10px] text-muted-foreground line-through tabular-nums">
                    {formatCurrency(shareInfo!.totalAmount)}
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
