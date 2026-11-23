"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { ChevronRight } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAccounts } from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { useVaquitas } from "@/hooks/use-vaquitas";
import { db } from "@/lib/firebase/client";
import { transactionsCollectionPath } from "@/lib/domain/installments";
import type { Installment, Transaction } from "@/lib/domain/types";
import { firstName, vaquitaDateText } from "@/lib/domain/vaquitas";
import { formatMoney } from "@/lib/format";
import { VaquitaExpenseForm, type MovedTransaction } from "./expense-form";
import { todayLocal } from "./shared";

const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Pasar a una vaquita un gasto mío ya cargado (desde Movimientos). Lo reemplaza: no se duplica. */
export function MoveToVaquitaSheet({ item, onClose }: { item: Installment | null; onClose: () => void }) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: vaquitas } = useVaquitas();
  const [tx, setTx] = useState<Transaction | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const open = useMemo(
    () =>
      vaquitas
        .filter((v) => v.status !== "closed" && v.members.some((m) => m.uid === user?.uid))
        .sort((a, b) => (b.updatedAt?.toDate().getTime() ?? 0) - (a.updatedAt?.toDate().getTime() ?? 0)),
    [vaquitas, user?.uid],
  );

  useEffect(() => {
    if (!item || !user) return;
    let alive = true;
    getDoc(doc(db, transactionsCollectionPath(user.uid), item.transactionId)).then((snap) => {
      if (alive && snap.exists()) setTx({ id: snap.id, ...(snap.data() as Omit<Transaction, "id">) });
    });
    return () => {
      alive = false;
    };
  }, [item, user]);

  if (!item) return null;
  // Con una sola vaquita abierta, directo al formulario.
  const vaquita = open.find((v) => v.id === picked) ?? (open.length === 1 ? open[0] : null);
  const moved: MovedTransaction | null = tx
    ? {
        id: tx.id,
        description: tx.description ?? "",
        amount: tx.totalAmount,
        currency: tx.currency ?? "ARS",
        date: tx.purchaseDate ? ymdLocal(tx.purchaseDate.toDate()) : todayLocal(),
        accountName: accounts.find((a) => a.id === tx.accountId)?.name ?? "tu cuenta",
        installments: Math.max(1, tx.installments ?? 1),
      }
    : null;

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>{vaquita ? `Pasar a «${vaquita.name}»` : "Pasar a una vaquita"}</SheetTitle>
          {moved && (
            <p className="text-sm text-muted-foreground">
              {moved.description || "Gasto"} · {formatMoney(moved.amount, moved.currency)}
            </p>
          )}
        </SheetHeader>
        <div className="px-5 pb-6 pt-2">
          {open.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No tenés vaquitas abiertas.</p>
          ) : !vaquita ? (
            <div className="divide-y rounded-2xl border">
              {open.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setPicked(v.id)}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{v.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[vaquitaDateText(v), v.members.map((m) => (m.uid === user?.uid ? "vos" : firstName(m.name))).join(", ")]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          ) : !moved ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
          ) : (
            <>
              {open.length > 1 && (
                <button type="button" className="mb-3 text-xs font-medium text-brand" onClick={() => setPicked(null)}>
                  ← Otra vaquita
                </button>
              )}
              <VaquitaExpenseForm key={vaquita.id} vaquita={vaquita} fromTransaction={moved} onDone={onClose} />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
