"use client";

import { useMemo, useState } from "react";
import { CalendarDays, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useActivities } from "@/hooks/use-data";
import { apiFetch } from "@/lib/api";
import {
  dayLabel,
  myParticipation,
  participantName,
  setActivityExpense,
  ymdAR,
  type Activity,
  type ActivityParticipant,
} from "@/lib/domain/activities";
import { ActivityCard, type ActivityCardActions } from "@/components/agenda/activity-card";
import { ActivityForm } from "@/components/agenda/activity-form";
import { TransactionForm } from "@/components/transactions/transaction-form";
import type { ShareSplit } from "@/components/transactions/share-section";

type Mine = { activity: Activity; me: ActivityParticipant };

export default function AgendaPage() {
  const { user } = useAuth();
  const { data, loading } = useActivities();
  const today = ymdAR();
  const [formFor, setFormFor] = useState<{ activity?: Activity } | null>(null);
  const [expenseFor, setExpenseFor] = useState<{ activity: Activity; split: boolean } | null>(null);

  const mine = useMemo<Mine[]>(
    () =>
      user
        ? data
            .map((activity) => ({ activity, me: myParticipation(activity, user) }))
            .filter((x): x is Mine => !!x.me && x.me.status !== "rejected")
        : [],
    [data, user],
  );
  const invitations = mine.filter((x) => x.me.status === "pending" && x.activity.date >= today);
  const upcoming = mine.filter((x) => x.me.status !== "pending" && x.activity.date >= today);
  const past = mine.filter((x) => x.me.status !== "pending" && x.activity.date < today).reverse();

  const actions: ActivityCardActions = {
    onRespond: async (a, response) => {
      try {
        const r = await apiFetch("/api/activities/respond", {
          method: "POST",
          body: JSON.stringify({ activityId: a.id, response }),
        });
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error);
        toast.success(response === "accepted" ? "¡Agendado!" : "Listo, le avisamos");
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : "No se pudo responder");
      }
    },
    onEdit: (activity) => setFormFor({ activity }),
    onDelete: async (a) => {
      const invited = a.participants.filter((p) => p.status === "pending" || p.status === "accepted").length;
      const msg = invited
        ? `¿Cancelar "${a.title}"? Les avisamos a ${invited === 1 ? "la persona invitada" : `las ${invited} personas invitadas`}.`
        : `¿Eliminar "${a.title}"?`;
      if (!confirm(msg)) return;
      try {
        const r = await apiFetch("/api/activities/cancel", {
          method: "POST",
          body: JSON.stringify({ activityId: a.id }),
        });
        const data = (await r.json().catch(() => null)) as { error?: string; notified?: number } | null;
        if (!r.ok) throw new Error(data?.error);
        toast.success(
          data?.notified ? `Cancelada. Les avisamos a ${data.notified} ${data.notified === 1 ? "persona" : "personas"}` : "Eliminada",
        );
      } catch (err) {
        console.error(err);
        toast.error(err instanceof Error && err.message ? err.message : "No se pudo cancelar");
      }
    },
    onAddExpense: (activity, split) => setExpenseFor({ activity, split }),
    onUnlinkExpense: async (a) => {
      if (!user) return;
      if (!confirm("¿Desvincular el gasto de esta actividad? El gasto sigue en tus movimientos.")) return;
      await setActivityExpense(a.id, user.uid, null).catch(() => toast.error("No se pudo desvincular"));
    },
  };

  const expenseInitial = useMemo(() => {
    if (!expenseFor || !user) return undefined;
    const a = expenseFor.activity;
    const others = a.participants.filter(
      (p) => p.uid !== user.uid && (p.status === "owner" || p.status === "accepted"),
    );
    const each = Math.floor(100 / (others.length + 1));
    const shareWith: ShareSplit[] = expenseFor.split
      ? others.map((p) => ({
          contactId: `email:${p.email}`,
          email: p.email,
          displayName: p.displayName ?? participantName(p),
          uid: p.uid,
          photoURL: p.photoURL ?? null,
          percentage: each,
        }))
      : [];
    return {
      description: a.title,
      // Si se paga antes (entradas, seña), la fecha es hoy.
      date: a.date < today ? a.date : today,
      amount: a.estimatedAmount ?? null,
      currency: a.currency ?? "ARS",
      shareWith,
    };
  }, [expenseFor, user, today]);

  const renderGroups = (list: Mine[], isPast: boolean, showEmptyToday: boolean) => {
    const groups = new Map<string, Mine[]>();
    if (showEmptyToday) groups.set(today, []);
    for (const x of list) {
      const g = groups.get(x.activity.date) ?? [];
      g.push(x);
      groups.set(x.activity.date, g);
    }
    return [...groups.entries()].map(([day, items]) => (
      <section key={day} className="space-y-2">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {dayLabel(day, today)}
        </h2>
        {items.length === 0 && (
          <p className="px-1 text-sm text-muted-foreground">Nada agendado para hoy.</p>
        )}
        {items.map(({ activity, me }) => (
          <ActivityCard
            key={activity.id}
            activity={activity}
            me={me}
            myUid={user!.uid}
            past={isPast}
            actions={actions}
          />
        ))}
      </section>
    ));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agenda</h1>
          <p className="text-sm text-muted-foreground">
            Lo que tenés día a día. Compartila con quien va y cargá lo que gastes.
          </p>
        </div>
        <Button className="bg-brand-grad text-white hover:opacity-95" onClick={() => setFormFor({})}>
          <Plus className="mr-1 size-4" /> Nueva actividad
        </Button>
      </div>

      {invitations.length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-primary">
            Te invitaron · {invitations.length}
          </h2>
          {invitations.map(({ activity, me }) => (
            <div key={activity.id} className="space-y-1">
              <p className="px-1 text-[11px] text-muted-foreground">{dayLabel(activity.date, today)}</p>
              <ActivityCard activity={activity} me={me} myUid={user!.uid} actions={actions} />
            </div>
          ))}
        </section>
      )}

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!loading && mine.length === 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-16 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
              <CalendarDays className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Tu agenda está vacía</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Anotá turnos, salidas, cumpleaños o viajes. Cada mañana te avisamos lo que tenés, y si
              algo lleva un gasto lo cargás con un toque. También podés pedírselo al bot de WhatsApp.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && mine.length > 0 && (
        <Tabs defaultValue="upcoming">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="upcoming">Próximas · {upcoming.length}</TabsTrigger>
            <TabsTrigger value="past">Pasadas · {past.length}</TabsTrigger>
          </TabsList>
          <TabsContent value="upcoming" className="space-y-5 pt-3">
            {renderGroups(upcoming, false, true)}
          </TabsContent>
          <TabsContent value="past" className="space-y-5 pt-3">
            {past.length === 0 && <p className="px-1 text-sm text-muted-foreground">Todavía no hay pasadas.</p>}
            {renderGroups(past, true, false)}
          </TabsContent>
        </Tabs>
      )}

      <Sheet open={!!formFor} onOpenChange={(o) => !o && setFormFor(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>{formFor?.activity ? "Editar actividad" : "Nueva actividad"}</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {formFor && (
              <ActivityForm
                key={formFor.activity?.id ?? "new"}
                activity={formFor.activity}
                onDone={() => setFormFor(null)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={!!expenseFor} onOpenChange={(o) => !o && setExpenseFor(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Gasto de “{expenseFor?.activity.title}”</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {expenseFor && user && (
              <TransactionForm
                key={`${expenseFor.activity.id}-${expenseFor.split}`}
                initial={expenseInitial}
                onSaved={async (info) => {
                  await setActivityExpense(expenseFor.activity.id, user.uid, {
                    transactionId: info.transactionId,
                    amount: info.amount,
                    currency: info.currency,
                    byName: user.displayName ?? null,
                    sharedExpenseId: info.sharedExpenseId,
                  });
                }}
                onSubmitted={() => setExpenseFor(null)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
