"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarSync, LayoutList, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useActivities } from "@/hooks/use-data";
import { useMonth } from "@/hooks/use-month";
import { formatMonth } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ENTER, enterDelay } from "@/components/motion/enter";
import { MonthCalendar } from "@/components/agenda/month-calendar";
import { CalendarSyncSheet } from "@/components/agenda/calendar-sync-sheet";
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

type Mine = { activity: Activity; me: ActivityParticipant };
type View = "list" | "calendar";
const VIEW_KEY = "agenda-view";

export default function AgendaPage() {
  const { user } = useAuth();
  const { data, loading, error } = useActivities();
  const today = ymdAR();
  const { monthKey, year, month } = useMonth();
  const [formFor, setFormFor] = useState<{ activity?: Activity; date?: string } | null>(null);
  const [view, setView] = useState<View>("list");
  // La vista elegida queda para la próxima vez (en este dispositivo).
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preferencia guardada, solo existe en el cliente
    if (saved === "list" || saved === "calendar") setView(saved);
  }, []);
  const changeView = (v: View) => {
    setView(v);
    window.localStorage.setItem(VIEW_KEY, v);
  };
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
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
  // Lo del mes elegido (las invitaciones sin responder van arriba, aparte).
  const inMonth = mine.filter((x) => x.activity.date.startsWith(monthKey));
  const monthActivities = inMonth.filter((x) => x.me.status !== "pending");
  const isCurrentMonth = today.startsWith(monthKey);
  // Día elegido en el calendario: si no eligió uno de este mes, hoy (si es el
  // mes actual) o el primer día con algo agendado.
  const selectedDay =
    pickedDay?.startsWith(monthKey)
      ? pickedDay
      : isCurrentMonth
        ? today
        : (monthActivities[0]?.activity.date ?? `${monthKey}-01`);
  const dayItems = inMonth.filter((x) => x.activity.date === selectedDay);

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
      await setActivityExpense(a.id, user.uid, null, a.expenses?.[user.uid]?.transactionId).catch(() =>
        toast.error("No se pudo desvincular"),
      );
    },
  };

  // (Sin useMemo: lo memoiza el React Compiler.)
  const expenseInitial = (() => {
    if (!expenseFor || !user) return undefined;
    const a = expenseFor.activity;
    const others = a.participants.filter(
      (p) => p.uid !== user.uid && (p.status === "owner" || p.status === "accepted"),
    );
    // Dividir con los que van y usan la app (si no están conectados, el formulario lo avisa).
    const splitWith = expenseFor.split
      ? others
          .filter((p): p is typeof p & { uid: string } => !!p.uid)
          .map((p) => ({ uid: p.uid, name: p.displayName ?? participantName(p) }))
      : [];
    return {
      description: a.title,
      // Si se paga antes (entradas, seña), la fecha es hoy.
      date: a.date < today ? a.date : today,
      amount: a.estimatedAmount ?? null,
      currency: a.currency ?? "ARS",
      splitWith,
    };
  })();

  const renderCard = ({ activity, me }: Mine) =>
    me.status === "pending" ? (
      <ActivityCard key={activity.id} activity={activity} me={me} myUid={user!.uid} actions={actions} />
    ) : (
      <ActivityCard
        key={activity.id}
        activity={activity}
        me={me}
        myUid={user!.uid}
        past={activity.date < today}
        actions={actions}
      />
    );

  /** Lista del mes agrupada por día (en el mes actual, "Hoy" aparece aunque no haya nada). */
  const renderList = () => {
    const groups = new Map<string, Mine[]>();
    if (isCurrentMonth) groups.set(today, []);
    for (const x of monthActivities) {
      const g = groups.get(x.activity.date) ?? [];
      g.push(x);
      groups.set(x.activity.date, g);
    }
    const days = [...groups.keys()].sort();
    if (monthActivities.length === 0 && !isCurrentMonth) {
      return (
        <Card className={cn("rounded-3xl", ENTER)}>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No tenés nada agendado en {formatMonth(year, month)}.
            <div className="mt-3">
              <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setFormFor({ date: `${monthKey}-01` })}>
                <Plus className="size-4" /> Agendar algo
              </Button>
            </div>
          </CardContent>
        </Card>
      );
    }
    return days.map((day, i) => {
      const items = groups.get(day) ?? [];
      return (
        <section key={day} className={cn("space-y-2", ENTER)} style={enterDelay(i)}>
          <h2
            className={cn(
              "px-1 text-xs font-semibold uppercase tracking-wider",
              day === today ? "text-primary" : "text-muted-foreground",
            )}
          >
            {dayLabel(day, today)}
          </h2>
          {items.length === 0 && <p className="px-1 text-sm text-muted-foreground">Nada agendado para hoy.</p>}
          {items.map(renderCard)}
        </section>
      );
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agenda</h1>
          <p className="text-sm text-muted-foreground">{formatMonth(year, month)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => setSyncOpen(true)}
            aria-label="Ver la agenda en tu calendario"
            title="Ver la agenda en Google Calendar o en el celular"
          >
            <CalendarSync className="size-4" /> <span className="hidden lg:inline">Tu calendario</span>
          </Button>
          <Tabs value={view} onValueChange={(v) => changeView(v as View)}>
            <TabsList>
              <TabsTrigger value="list" aria-label="Ver en lista">
                <LayoutList /> <span className="hidden sm:inline">Lista</span>
              </TabsTrigger>
              <TabsTrigger value="calendar" aria-label="Ver en calendario">
                <CalendarDays /> <span className="hidden sm:inline">Calendario</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button className="bg-brand-grad text-white hover:opacity-95" onClick={() => setFormFor({})}>
            <Plus className="size-4" /> <span className="hidden sm:inline">Nueva actividad</span>
            <span className="sm:hidden">Nueva</span>
          </Button>
        </div>
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

      {!loading && error && mine.length === 0 && (
        <Card className="rounded-3xl border-destructive/30">
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No pudimos cargar tu agenda</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Probá recargar la página en un rato. Si sigue pasando, avisanos.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && mine.length === 0 && (
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

      {!loading && mine.length > 0 && view === "list" && (
        // key: al cambiar de mes la lista se vuelve a montar y los días entran en cascada.
        <div key={`list-${monthKey}`} className="space-y-5">
          {renderList()}
        </div>
      )}

      {!loading && mine.length > 0 && view === "calendar" && (
        <div className="space-y-4">
          <div key={`cal-${monthKey}`} className="animate-in fade-in-0 duration-300 motion-reduce:animate-none">
            <MonthCalendar
              year={year}
              month={month}
              today={today}
              selected={selectedDay}
              items={inMonth.map((x) => ({ activity: x.activity, pending: x.me.status === "pending" }))}
              onSelect={setPickedDay}
            />
          </div>
          <section key={`day-${selectedDay}`} className={cn("space-y-2", ENTER)}>
            <div className="flex items-center justify-between gap-2 px-1">
              <h2
                className={cn(
                  "text-xs font-semibold uppercase tracking-wider",
                  selectedDay === today ? "text-primary" : "text-muted-foreground",
                )}
              >
                {dayLabel(selectedDay, today)}
              </h2>
              <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => setFormFor({ date: selectedDay })}>
                <Plus className="size-4" /> Agendar este día
              </Button>
            </div>
            {dayItems.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">Nada agendado.</p>
            ) : (
              dayItems.map(renderCard)
            )}
          </section>
        </div>
      )}

      <CalendarSyncSheet open={syncOpen} onOpenChange={setSyncOpen} />

      <Sheet open={!!formFor} onOpenChange={(o) => !o && setFormFor(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>{formFor?.activity ? "Editar actividad" : "Nueva actividad"}</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {formFor && (
              <ActivityForm
                key={formFor.activity?.id ?? `new-${formFor.date ?? ""}`}
                activity={formFor.activity}
                defaultDate={formFor.date}
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
                modes={["expense"]}
                initial={expenseInitial}
                onSaved={async (info) => {
                  await setActivityExpense(expenseFor.activity.id, user.uid, {
                    transactionId: info.transactionId,
                    amount: info.amount,
                    currency: info.currency,
                    byName: user.displayName ?? null,
                    sharedExpenseId: info.splitId,
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
