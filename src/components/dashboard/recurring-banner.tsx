"use client";

import { useEffect, useState } from "react";
import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { Repeat } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts, useRecurring } from "@/hooks/use-data";
import { useMonth } from "@/hooks/use-month";
import { db } from "@/lib/firebase/client";
import {
  applyAllRecurringToMonth,
  isInRange,
} from "@/lib/domain/recurring";
import { installmentsCollectionPath } from "@/lib/domain/installments";
import { formatMonth } from "@/lib/format";
import type { RecurringExpense } from "@/lib/domain/types";
import { Reveal } from "@/components/motion/reveal";

interface BannerContent {
  pending: RecurringExpense[];
  year: number;
  month: number;
}

export function RecurringBanner() {
  const { user } = useAuth();
  const { data: recurring } = useRecurring();
  const { data: accounts } = useAccounts();
  const { monthKey, year, month } = useMonth();
  // `open`: si hay fijos sin aplicar en el mes que se está viendo (se decide
  // recién cuando llega la consulta de ESE mes, para no comparar con los del
  // mes anterior). `content` guarda lo último que se mostró, así el cartel
  // se pliega con su texto en vez de vaciarse de golpe.
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<BannerContent | null>(null);
  const [busy, setBusy] = useState(false);
  // Se incrementa al aplicar, para volver a leer qué fijos ya están en el mes.
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      const snap = await getDocs(
        query(
          collection(db, installmentsCollectionPath(user.uid)),
          where("billingMonth", "==", monthKey),
        ),
      );
      if (!active) return;
      const applied = new Set<string>();
      snap.forEach((d) => {
        const r = (d.data() as { recurringId?: string }).recurringId;
        if (r) applied.add(r);
      });
      const pending = recurring.filter((r) => r.active && isInRange(r, year, month) && !applied.has(r.id));
      setOpen(pending.length > 0);
      if (pending.length > 0) setContent({ pending, year, month });
    })();
    return () => {
      active = false;
    };
  }, [user, monthKey, year, month, recurring, refresh]);

  const apply = async () => {
    if (!user || !content) return;
    setBusy(true);
    try {
      const { applied: count } = await applyAllRecurringToMonth(
        user.uid,
        content.pending,
        accounts,
        content.year,
        content.month,
      );
      toast.success(`${count} ${count === 1 ? "fijo aplicado" : "fijos aplicados"}`);
      setRefresh((n) => n + 1);
    } catch (err) {
      toast.error("Error al aplicar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  // Al cambiar de mes se pliega enseguida (lo que muestra es de otro mes) y,
  // si el mes nuevo también tiene fijos sin aplicar, se despliega al llegar.
  const visible = open && content?.year === year && content?.month === month;

  return (
    <Reveal show={visible}>
      {content && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-3 text-sm">
            <div className="flex size-9 items-center justify-center rounded-xl bg-brand-grad text-white">
              <Repeat className="size-4" />
            </div>
            <div>
              <div className="font-medium">
                {content.pending.length} {content.pending.length === 1 ? "fijo sin aplicar" : "fijos sin aplicar"} a{" "}
                {formatMonth(content.year, content.month)}
              </div>
              <div className="text-xs text-muted-foreground">
                {content.pending
                  .slice(0, 3)
                  .map((r) => r.name)
                  .join(", ")}
                {content.pending.length > 3 ? "…" : ""}
              </div>
            </div>
          </div>
          <Button size="sm" onClick={apply} disabled={busy || !visible}>
            {busy ? "Aplicando…" : "Aplicar"}
          </Button>
        </div>
      )}
    </Reveal>
  );
}
