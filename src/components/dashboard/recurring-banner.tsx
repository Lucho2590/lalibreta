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

export function RecurringBanner() {
  const { user } = useAuth();
  const { data: recurring } = useRecurring();
  const { data: accounts } = useAccounts();
  const { monthKey, year, month } = useMonth();
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

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
      const ids = new Set<string>();
      snap.forEach((d) => {
        const r = (d.data() as { recurringId?: string }).recurringId;
        if (r) ids.add(r);
      });
      if (active) setAppliedIds(ids);
    })();
    return () => {
      active = false;
    };
  }, [user, monthKey, recurring]);

  const pending = recurring.filter(
    (r) => r.active && isInRange(r, year, month) && !appliedIds.has(r.id),
  );

  if (pending.length === 0) return null;

  const apply = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const { applied } = await applyAllRecurringToMonth(
        user.uid,
        pending,
        accounts,
        year,
        month,
      );
      toast.success(`${applied} ${applied === 1 ? "fijo aplicado" : "fijos aplicados"}`);
    } catch (err) {
      toast.error("Error al aplicar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3 text-sm">
        <div className="flex size-9 items-center justify-center rounded-xl bg-brand-grad text-white">
          <Repeat className="size-4" />
        </div>
        <div>
          <div className="font-medium">
            {pending.length} {pending.length === 1 ? "fijo sin aplicar" : "fijos sin aplicar"} a{" "}
            {formatMonth(year, month)}
          </div>
          <div className="text-xs text-muted-foreground">
            {pending
              .slice(0, 3)
              .map((r) => r.name)
              .join(", ")}
            {pending.length > 3 ? "…" : ""}
          </div>
        </div>
      </div>
      <Button size="sm" onClick={apply} disabled={busy}>
        {busy ? "Aplicando…" : "Aplicar"}
      </Button>
    </div>
  );
}
