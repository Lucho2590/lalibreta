"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SplitSection, splitPayload, type SplitState } from "@/components/transactions/split-section";
import { apiPost, errorText } from "@/lib/api";
import type { Installment } from "@/lib/domain/types";
import { currencyOf } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

/** Dividir un gasto que ya estaba cargado (desde la lista de movimientos). */
export function SplitExistingSheet({ item, onClose }: { item: Installment | null; onClose: () => void }) {
  const [split, setSplit] = useState<SplitState>({ enabled: true, people: [], mode: "installments" });
  const [busy, setBusy] = useState(false);
  if (!item) return null;
  const currency = currencyOf(item);
  // Total de la compra (si es en cuotas, todas las cuotas).
  const total = Math.round(item.amount * Math.max(1, item.totalInstallments) * 100) / 100;

  const save = async () => {
    const payload = splitPayload(total, split);
    if (payload.error) return toast.error(payload.error);
    setBusy(true);
    try {
      await apiPost("/api/splits", { txId: item.transactionId, mode: split.mode, participants: payload.participants });
      const apps = split.people.filter((p) => p.isApp).length;
      toast.success(apps > 0 ? "Dividido: les llegó para aceptar" : "Dividido: queda anotado lo que te deben");
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>Dividir “{item.description || "gasto"}”</SheetTitle>
          <p className="text-sm text-muted-foreground">
            {formatMoney(total, currency)}
            {item.totalInstallments > 1 && ` en ${item.totalInstallments} cuotas`}
          </p>
        </SheetHeader>
        <div className="space-y-4 px-5 pb-6 pt-3">
          <SplitSection
            totalAmount={total}
            currency={currency}
            installments={item.totalInstallments}
            value={split}
            onChange={setSplit}
            alwaysOn
          />
          <Button className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={busy} onClick={save}>
            {busy ? "Guardando…" : "Dividir"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
