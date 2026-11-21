"use client";

import { useState } from "react";
import { CalendarDays, ClipboardCheck, Inbox, MapPin, Repeat } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { usePendingApprovalsAsOwner } from "@/hooks/use-data";
import { useWeather } from "@/hooks/use-weather";
import { Reveal } from "@/components/motion/reveal";
import { ENTER, enterDelay } from "@/components/motion/enter";
import { ApprovalsBanner } from "@/components/dashboard/approvals-banner";
import { RecurringBanner, useRecurringPending } from "@/components/dashboard/recurring-banner";
import { TodayAgenda, useTodayAgenda } from "@/components/dashboard/today-agenda";
import { WeatherCardContent, weatherCardVisible } from "@/components/dashboard/weather-card";
import { PendingInbox, usePendingForMe } from "@/components/people/pending-inbox";
import { weatherEmoji } from "@/lib/domain/weather";
import { cn } from "@/lib/utils";

interface Shortcut {
  key: string;
  label: string;
  icon: React.ReactNode;
  /** Pide que hagas algo (aprobar, responder, aplicar): va resaltado. */
  action?: boolean;
  badge?: number | string;
  /** Clases extra del círculo (ej. color de la alerta del SMN). */
  tone?: string;
  content: React.ReactNode;
}

/**
 * Debajo de la barra del mes: lo que antes eran tarjetas arriba del balance
 * (fijos sin aplicar, pendientes, clima, agenda) queda como una fila de
 * íconos. Solo aparecen los que tienen algo; al tocar uno se abre su tarjeta
 * en una hoja desde abajo.
 */
export function HomeShortcuts() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const close = () => setOpenKey(null);

  const { data: approvals } = usePendingApprovalsAsOwner();
  const pending = usePendingForMe();
  const recurring = useRecurringPending();
  const agenda = useTodayAgenda();
  const { data: weather, loading: weatherLoading } = useWeather();

  const items: Shortcut[] = [];
  if (approvals.length > 0) {
    items.push({
      key: "approvals",
      label: "Aprobar",
      icon: <ClipboardCheck className="size-6" />,
      action: true,
      badge: approvals.length,
      content: <ApprovalsBanner />,
    });
  }
  if (pending.count > 0) {
    items.push({
      key: "pending",
      label: "Responder",
      icon: <Inbox className="size-6" />,
      action: true,
      badge: pending.count,
      content: <PendingInbox />,
    });
  }
  if (recurring.visible) {
    items.push({
      key: "recurring",
      label: "Fijos",
      icon: <Repeat className="size-6" />,
      action: true,
      badge: recurring.content?.pending.length,
      content: <RecurringBanner state={recurring} onApplied={close} />,
    });
  }
  if (agenda.visible) {
    const n = agenda.todays.length + agenda.invites;
    items.push({
      key: "agenda",
      label: "Agenda",
      icon: <CalendarDays className="size-6" />,
      badge: n > 0 ? n : undefined,
      content: <TodayAgenda />,
    });
  }
  if (weatherCardVisible(weather, weatherLoading)) {
    const f = weather.forecast;
    const alert = weather.alerts[0];
    items.push({
      key: "weather",
      label: f ? `${Math.round(f.current.temperature)}°` : "Clima",
      icon: f ? (
        <span className="text-2xl leading-none" aria-hidden>
          {weatherEmoji(f.current.weatherCode, f.current.isDay)}
        </span>
      ) : (
        <MapPin className="size-6" />
      ),
      badge: alert ? "!" : undefined,
      tone: alert ? ALERT_RING[alert.level] : undefined,
      content: <WeatherCardContent data={weather} />,
    });
  }

  const active = items.find((i) => i.key === openKey);

  return (
    <>
      <Reveal show={items.length > 0}>
        {/* -mx-4 px-4: el scroll llega hasta el borde de la pantalla. */}
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 pt-1.5 [scrollbar-width:none] md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden">
          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              onClick={() => setOpenKey(it.key)}
              className={cn("flex w-16 shrink-0 snap-start flex-col items-center gap-1.5", ENTER)}
              style={enterDelay(i)}
            >
              <span
                className={cn(
                  "relative flex size-14 items-center justify-center rounded-2xl shadow-sm transition active:scale-95",
                  it.action ? "bg-brand-grad text-white" : "bg-card text-primary ring-1 ring-border",
                  it.tone,
                )}
              >
                {it.icon}
                {it.badge != null && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold tabular-nums text-white ring-2 ring-background">
                    {it.badge}
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center text-xs font-medium text-muted-foreground">
                {it.label}
              </span>
            </button>
          ))}
        </div>
      </Reveal>

      <Sheet open={!!active} onOpenChange={(o) => !o && close()}>
        <SheetContent
          side="bottom"
          className="sheet-md-modal max-h-[85dvh] gap-0 overflow-y-auto rounded-t-3xl p-0 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            {/* La agenda y "Para responder" ya traen su propio título en la tarjeta. */}
            <SheetTitle className={cn(active && OWN_TITLE.has(active.key) && "sr-only")}>
              {active ? SHEET_TITLE[active.key] ?? active.label : ""}
            </SheetTitle>
          </SheetHeader>
          <div className="px-4">{active?.content}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}

const SHEET_TITLE: Record<string, string> = {
  approvals: "Para aprobar",
  pending: "Para responder",
  recurring: "Fijos del mes",
  agenda: "Agenda",
  weather: "Clima",
};

const OWN_TITLE = new Set(["agenda", "pending"]);

const ALERT_RING = {
  amarilla: "ring-2 ring-yellow-400",
  naranja: "ring-2 ring-orange-500",
  roja: "ring-2 ring-red-500",
} as const;
