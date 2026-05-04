"use client";

import { useEffect, useMemo, useState } from "react";
import { Timestamp } from "firebase/firestore";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import {
  buildDefaultCycle,
  getOrBuildCycle,
  saveCycle,
} from "@/lib/domain/cycles";
import {
  regenerateFutureInstallmentsForAccount,
} from "@/lib/domain/installments";
import type { Account, CardCycle } from "@/lib/domain/types";
import { monthKey, parseMonthKey } from "@/lib/domain/types";
import { formatMonth, formatDate } from "@/lib/format";

const toDateInput = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export function CardCycleEditor({ account }: { account: Account }) {
  const { user } = useAuth();
  const today = new Date();
  const [{ year, month }, setYM] = useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  }));
  const [cycle, setCycle] = useState<CardCycle | null>(null);
  const [closing, setClosing] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);

  const key = useMemo(() => monthKey(year, month), [year, month]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      const c = await getOrBuildCycle(user.uid, account, year, month);
      if (!active) return;
      setCycle(c);
      setClosing(toDateInput(c.closingDate.toDate()));
      setDue(toDateInput(c.dueDate.toDate()));
    })();
    return () => {
      active = false;
    };
  }, [user, account, year, month]);

  const shift = (delta: number) => {
    const total = month - 1 + delta;
    const newYear = year + Math.floor(total / 12);
    const newMonth = ((total % 12) + 12) % 12 + 1;
    setYM({ year: newYear, month: newMonth });
  };

  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await saveCycle(user.uid, account.id, {
        year,
        month,
        closingDate: Timestamp.fromDate(new Date(`${closing}T23:59:59`)),
        dueDate: Timestamp.fromDate(new Date(`${due}T12:00:00`)),
      });
      toast.success("Ciclo actualizado");
    } catch (err) {
      toast.error("No se pudo guardar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const resetToDefault = () => {
    const def = buildDefaultCycle(account, year, month);
    setClosing(toDateInput(def.closingDate.toDate()));
    setDue(toDateInput(def.dueDate.toDate()));
  };

  const recalc = async () => {
    if (!user) return;
    setRecalcBusy(true);
    try {
      await regenerateFutureInstallmentsForAccount(user.uid, account, key);
      toast.success("Cuotas futuras recalculadas");
    } catch (err) {
      toast.error("Error al recalcular");
      console.error(err);
    } finally {
      setRecalcBusy(false);
    }
  };

  if (account.type !== "credit") return null;

  return (
    <Card className="rounded-3xl">
      <CardContent className="space-y-3 py-4">
        <div className="text-sm font-semibold">Ciclos del resumen</div>
        <p className="-mt-1 text-xs text-muted-foreground">
          Personalizá el cierre y vencimiento de cada mes.
        </p>
        <div className="flex items-center justify-between">
          <Button size="sm" variant="ghost" onClick={() => shift(-1)}>
            ← Anterior
          </Button>
          <div className="text-sm font-medium">{formatMonth(year, month)}</div>
          <Button size="sm" variant="ghost" onClick={() => shift(1)}>
            Siguiente →
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="cycle-closing" className="text-xs">
              Cierre
            </Label>
            <Input
              id="cycle-closing"
              type="date"
              value={closing}
              onChange={(e) => setClosing(e.target.value)}
              className="h-11"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cycle-due" className="text-xs">
              Vencimiento
            </Label>
            <Input
              id="cycle-due"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="h-11"
            />
          </div>
        </div>

        {cycle && (
          <p className="text-xs text-muted-foreground">
            Actual: cierre {formatDate(cycle.closingDate.toDate())} · vto{" "}
            {formatDate(cycle.dueDate.toDate())}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy} size="sm">
            {busy ? "Guardando…" : "Guardar ciclo"}
          </Button>
          <Button onClick={resetToDefault} variant="outline" size="sm">
            Volver al default
          </Button>
          <Button onClick={recalc} variant="secondary" size="sm" disabled={recalcBusy}>
            {recalcBusy ? "Recalculando…" : "Recalcular cuotas futuras"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {(() => {
            const { year: y, month: m } = parseMonthKey(key);
            return `Recalcular toma efecto desde ${formatMonth(y, m)} en adelante.`;
          })()}
        </p>
      </CardContent>
    </Card>
  );
}
