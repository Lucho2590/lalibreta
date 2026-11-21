"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { Activity } from "@/lib/domain/activities";

const WEEKDAYS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];

export interface CalendarItem {
  activity: Activity;
  /** Invitación sin responder (se dibuja distinta). */
  pending: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Las semanas del mes (lunes a domingo); null = casillero vacío. */
const monthWeeks = (year: number, month: number): Array<Array<string | null>> => {
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const lead = (first.getUTCDay() + 6) % 7; // lunes = 0
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${pad(month)}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
};

/**
 * Grilla del mes. En la compu cada día muestra hasta 2 actividades (hora +
 * título); en el celular, puntitos. Tocar un día lo selecciona.
 */
export function MonthCalendar({
  year,
  month,
  today,
  selected,
  items,
  onSelect,
}: {
  year: number;
  month: number;
  today: string;
  selected: string;
  items: CalendarItem[];
  onSelect: (day: string) => void;
}) {
  const weeks = useMemo(() => monthWeeks(year, month), [year, month]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of items) {
      const list = m.get(it.activity.date) ?? [];
      list.push(it);
      m.set(it.activity.date, list);
    }
    return m;
  }, [items]);

  return (
    <div className="overflow-hidden rounded-3xl bg-card ring-1 ring-foreground/10">
      <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {weeks.flat().map((day, i) => {
          if (!day) return <div key={`empty-${i}`} className="min-h-14 border-b border-r bg-muted/20 md:min-h-24 [&:nth-child(7n)]:border-r-0" />;
          const list = byDay.get(day) ?? [];
          const isToday = day === today;
          const isSelected = day === selected;
          const isPast = day < today;
          return (
            <button
              key={day}
              type="button"
              onClick={() => onSelect(day)}
              aria-pressed={isSelected}
              aria-label={`${Number(day.slice(8))}${list.length ? `, ${list.length} ${list.length === 1 ? "actividad" : "actividades"}` : ""}`}
              className={cn(
                "flex min-h-14 flex-col items-stretch gap-1 border-b border-r p-1 text-left transition md:min-h-24 md:p-1.5 [&:nth-child(7n)]:border-r-0",
                isSelected ? "bg-primary/[0.07]" : "hover:bg-muted/50",
              )}
            >
              <span
                className={cn(
                  "mx-auto flex size-6 items-center justify-center rounded-full text-xs tabular-nums md:mx-0",
                  isToday && "bg-brand-grad font-bold text-white",
                  !isToday && isSelected && "font-bold text-primary ring-1 ring-primary",
                  !isToday && !isSelected && isPast && "text-muted-foreground",
                )}
              >
                {Number(day.slice(8))}
              </span>
              {/* Celular: puntitos */}
              {list.length > 0 && (
                <span className="flex justify-center gap-0.5 md:hidden">
                  {list.slice(0, 3).map(({ activity, pending }) => (
                    <span
                      key={activity.id}
                      className={cn("size-1.5 rounded-full", pending ? "ring-1 ring-primary" : isPast ? "bg-muted-foreground/50" : "bg-primary")}
                    />
                  ))}
                </span>
              )}
              {/* Compu: hasta 2 actividades */}
              <span className="hidden min-w-0 flex-col gap-0.5 md:flex">
                {list.slice(0, 2).map(({ activity, pending }) => (
                  <span
                    key={activity.id}
                    className={cn(
                      "truncate rounded-md px-1.5 py-0.5 text-[11px] leading-4",
                      pending
                        ? "border border-dashed border-primary/50 text-primary"
                        : isPast
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary/10 text-primary",
                    )}
                    title={activity.title}
                  >
                    {activity.time && <span className="font-semibold tabular-nums">{activity.time} </span>}
                    {activity.title}
                  </span>
                ))}
                {list.length > 2 && (
                  <span className="px-1.5 text-[10px] font-medium text-muted-foreground">+{list.length - 2} más</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
