"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, History, PiggyBank, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NewVaquitaForm } from "@/components/vaquitas/new-vaquita-form";
import { useAuth } from "@/hooks/use-auth";
import { useVaquitas } from "@/hooks/use-vaquitas";
import { firstName, myUnitNet, vaquitaDateText, type Vaquita } from "@/lib/domain/vaquitas";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ENTER, enterDelay } from "@/components/motion/enter";

const dateOf = (v: Vaquita) => v.updatedAt?.toDate?.() ?? v.createdAt?.toDate?.() ?? new Date(0);
const dateText = (d: Date) => new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", year: "numeric" }).format(d);

function VaquitaRow({ v, index, uid }: { v: Vaquita; index: number; uid?: string }) {
  const net = myUnitNet(v, uid);
  const me = v.members.find((m) => m.uid === uid);
  const isFamily = !!me?.familyId && v.families.some((f) => f.id === me.familyId);
  const who = isFamily ? "Tu familia" : "Vos";
  const status =
    Math.abs(net) < 0.01
      ? { text: v.summary?.expenses ? "A mano" : "Sin gastos", cls: "text-muted-foreground" }
      : net > 0
        ? { text: `${who} recibe ${formatMoney(net, v.currency)}`, cls: "text-success" }
        : { text: `${who} debe ${formatMoney(-net, v.currency)}`, cls: "text-destructive" };
  return (
    <Link
      href={`/vaquitas/${v.id}`}
      style={enterDelay(index)}
      className={cn("flex items-center gap-3 py-3 hover:opacity-80", ENTER)}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
        <PiggyBank className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{v.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {vaquitaDateText(v) && <span className="font-medium">{vaquitaDateText(v)} · </span>}
          {v.families.length > 0
            ? v.families.map((f) => f.name).join(" · ")
            : v.members.map((m) => (m.uid === uid ? "Vos" : firstName(m.name))).join(", ")}
          {v.status === "closed" && !vaquitaDateText(v) && ` · ${dateText(v.closedAt?.toDate?.() ?? dateOf(v))}`}
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold tabular-nums">{formatMoney(v.summary?.total ?? 0, v.currency)}</div>
        <div className={cn("text-[11px] font-medium", status.cls)}>{status.text}</div>
      </div>
      <ChevronRight className="size-4 text-muted-foreground" />
    </Link>
  );
}

export default function VaquitasPage() {
  const { user } = useAuth();
  const { data, loading } = useVaquitas();
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => [...data].sort((a, b) => dateOf(b).getTime() - dateOf(a).getTime()), [data]);
  const active = sorted.filter((v) => v.status !== "closed");
  const closed = sorted.filter((v) => v.status === "closed");

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vaquitas</h1>
          <p className="text-sm text-muted-foreground">Gastos en grupo: quién puso qué y quién le paga a quién</p>
        </div>
        <Button className="bg-brand-grad text-white hover:opacity-95" onClick={() => setOpen(true)}>
          <Plus className="mr-1 size-4" /> Nueva
        </Button>
      </div>

      <Card className="rounded-3xl">
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
            <PiggyBank className="size-4" /> Abiertas
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {loading && <p className="py-2 text-xs text-muted-foreground">Cargando…</p>}
          {!loading && active.length === 0 && (
            <div className="space-y-3 py-6 text-center text-sm text-muted-foreground">
              <p>
                Armá una vaquita para una cena, una salida o un viaje. Cada uno carga lo que pagó y al final te dice
                quién le paga a quién.
              </p>
              <p className="text-xs">
                Se pueden armar familias (por ejemplo, vos y tu pareja contra otra pareja) y lo que pagás queda en tus
                cuentas, contando solo tu parte.
              </p>
              <Button variant="outline" onClick={() => setOpen(true)}>
                <Plus className="mr-1 size-4" /> Crear la primera
              </Button>
            </div>
          )}
          {active.map((v, i) => (
            <VaquitaRow key={v.id} v={v} index={i} uid={user?.uid} />
          ))}
        </CardContent>
      </Card>

      {closed.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <History className="size-4" /> Historial
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {closed.map((v, i) => (
              <VaquitaRow key={v.id} v={v} index={i} uid={user?.uid} />
            ))}
          </CardContent>
        </Card>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Nueva vaquita</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">{open && <NewVaquitaForm onCreated={() => setOpen(false)} />}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
