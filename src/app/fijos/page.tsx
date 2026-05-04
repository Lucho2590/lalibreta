"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { Check, Pause, Play, Plus, Repeat, Trash2 } from "lucide-react";
import { CategoryIcon } from "@/components/category-icon";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import {
  useAccounts,
  useCategories,
  useRecurring,
} from "@/hooks/use-data";
import { useMonth } from "@/hooks/use-month";
import { db } from "@/lib/firebase/client";
import {
  applyAllRecurringToMonth,
  applyRecurringToMonth,
  isInRange,
  recurringCollectionPath,
} from "@/lib/domain/recurring";
import { installmentsCollectionPath } from "@/lib/domain/installments";
import type { RecurringExpense } from "@/lib/domain/types";
import { formatCurrency, formatMonth } from "@/lib/format";
import { RecurringForm } from "@/components/recurring/recurring-form";

export default function FijosPage() {
  const { user } = useAuth();
  const { data: recurring, loading } = useRecurring();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const { monthKey, year, month } = useMonth();
  const [open, setOpen] = useState(false);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const [appliedSet, setAppliedSet] = useState<Set<string>>(new Set());
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
      if (active) setAppliedSet(ids);
    })();
    return () => {
      active = false;
    };
  }, [user, monthKey, recurring]);

  const applyOne = async (rec: RecurringExpense) => {
    if (!user) return;
    const account = accountMap.get(rec.accountId);
    if (!account) {
      toast.error("Cuenta del fijo no existe");
      return;
    }
    try {
      const result = await applyRecurringToMonth(user.uid, rec, year, month, account);
      if (result === "created") {
        toast.success(`"${rec.name}" aplicado a ${formatMonth(year, month)}`);
        setAppliedSet((s) => new Set(s).add(rec.id));
      } else {
        toast.info("Ya estaba aplicado");
      }
    } catch (err) {
      toast.error("No se pudo aplicar");
      console.error(err);
    }
  };

  const applyAll = async () => {
    if (!user) return;
    try {
      const { applied } = await applyAllRecurringToMonth(
        user.uid,
        recurring.filter((r) => r.active),
        accounts,
        year,
        month,
      );
      toast.success(
        applied > 0
          ? `${applied} ${applied === 1 ? "fijo aplicado" : "fijos aplicados"}`
          : "No había nada para aplicar",
      );
    } catch (err) {
      toast.error("Error al aplicar");
      console.error(err);
    }
  };

  const togglePause = async (rec: RecurringExpense) => {
    if (!user) return;
    await updateDoc(doc(db, `${recurringCollectionPath(user.uid)}/${rec.id}`), {
      active: !rec.active,
    });
  };

  const remove = async (rec: RecurringExpense) => {
    if (!user) return;
    if (!confirm(`¿Eliminar "${rec.name}"? Las instancias ya creadas se mantienen.`)) return;
    try {
      await deleteDoc(doc(db, `${recurringCollectionPath(user.uid)}/${rec.id}`));
      toast.success("Eliminado");
    } catch (err) {
      toast.error("No se pudo eliminar");
      console.error(err);
    }
  };

  const active = recurring.filter((r) => r.active);
  const paused = recurring.filter((r) => !r.active);

  const renderItem = (rec: RecurringExpense) => {
    const cat = categoryMap.get(rec.categoryId);
    const acc = accountMap.get(rec.accountId);
    const inRange = isInRange(rec, year, month);
    const applied = appliedSet.has(rec.id);
    return (
      <Card key={rec.id} className="rounded-2xl">
        <CardContent className="flex flex-wrap items-center gap-3 py-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
            <CategoryIcon name={cat?.icon} className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{rec.name}</span>
              {rec.kind === "income" && (
                <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                  Ingreso
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {cat?.name ?? "—"} · {acc?.name ?? "—"} · día {rec.dayOfMonth}
            </div>
          </div>
          <div className="text-sm font-semibold tabular-nums">{formatCurrency(rec.amount)}</div>

          <div className="flex w-full items-center justify-end gap-1 sm:w-auto">
            {rec.active && inRange && (
              applied ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
                  <Check className="size-3" /> Aplicado
                </span>
              ) : (
                <Button size="sm" variant="outline" onClick={() => applyOne(rec)}>
                  Aplicar a {formatMonth(year, month).split(" ")[0]}
                </Button>
              )
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => togglePause(rec)}
              aria-label={rec.active ? "Pausar" : "Activar"}
            >
              {rec.active ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => remove(rec)}
              aria-label="Eliminar"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Gastos fijos</h1>
          <p className="text-sm text-muted-foreground">
            Items que se repiten mes a mes — alquiler, sueldo, suscripciones…
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={applyAll} disabled={active.length === 0}>
            Aplicar todos a {formatMonth(year, month)}
          </Button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={<Button className="bg-brand-grad text-white hover:opacity-95" />}
            >
              <Plus className="mr-1 size-4" /> Nuevo fijo
            </SheetTrigger>
            <SheetContent
              side="bottom"
              className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0"
            >
              <SheetHeader className="px-5 pt-5">
                <SheetTitle>Nuevo gasto fijo</SheetTitle>
              </SheetHeader>
              <div className="px-5 pb-6 pt-2">
                <RecurringForm onCreated={() => setOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!loading && recurring.length === 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-16 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
              <Repeat className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No tenés gastos fijos todavía</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Cargá tu alquiler, sueldo o suscripciones y aplicalos cada mes con un click.
            </p>
          </CardContent>
        </Card>
      )}

      {recurring.length > 0 && (
        <Tabs defaultValue="active">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="active">Activos · {active.length}</TabsTrigger>
            <TabsTrigger value="paused">Pausados · {paused.length}</TabsTrigger>
          </TabsList>
          <TabsContent value="active" className="space-y-2 pt-2">
            {active.length === 0 && (
              <p className="px-2 text-xs text-muted-foreground">No hay activos.</p>
            )}
            {active.map(renderItem)}
          </TabsContent>
          <TabsContent value="paused" className="space-y-2 pt-2">
            {paused.length === 0 && (
              <p className="px-2 text-xs text-muted-foreground">No hay pausados.</p>
            )}
            {paused.map(renderItem)}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
