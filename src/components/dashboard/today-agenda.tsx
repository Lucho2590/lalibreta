"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CalendarDays, ChevronRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useActivities } from "@/hooks/use-data";
import {
  addDaysYMD,
  companions,
  myParticipation,
  participantName,
  ymdAR,
  type Activity,
} from "@/lib/domain/activities";

/** Lo de hoy y mañana, y las invitaciones sin responder. */
export function useTodayAgenda() {
  const { user } = useAuth();
  const { data } = useActivities();
  const today = ymdAR();
  const tomorrow = addDaysYMD(today, 1);

  return useMemo(() => {
    const going: Activity[] = [];
    let invites = 0;
    for (const a of data) {
      const me = user ? myParticipation(a, user) : null;
      if (!me || me.status === "rejected") continue;
      if (me.status === "pending") {
        if (a.date >= today) invites += 1;
        continue;
      }
      going.push(a);
    }
    const todays = going.filter((a) => a.date === today);
    const tomorrows = going.filter((a) => a.date === tomorrow);
    return {
      todays,
      tomorrows,
      invites,
      visible: !!user && (todays.length > 0 || tomorrows.length > 0 || invites > 0),
    };
  }, [data, user, today, tomorrow]);
}

/**
 * Lo de hoy y mañana, y las invitaciones sin responder. Va dentro de la hoja
 * que abre el atajo "Agenda" del inicio (el título lo pone la hoja).
 */
export function TodayAgenda() {
  const { user } = useAuth();
  const { todays, tomorrows, invites, visible } = useTodayAgenda();

  if (!user || !visible) return null;

  const row = (a: Activity) => {
    const others = companions(a, user).filter((p) => p.status === "owner" || p.status === "accepted");
    return (
      <li key={a.id} className="flex items-baseline gap-3 text-sm">
        <span className="w-11 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
          {a.time ?? "—"}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{a.title}</span>
          {others.length > 0 && (
            <span className="text-muted-foreground"> · con {others.map(participantName).join(", ")}</span>
          )}
        </span>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {invites > 0 && (
        <Link
          href="/agenda"
          className="flex items-center justify-between rounded-2xl bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/15"
        >
          {invites} {invites === 1 ? "invitación sin responder" : "invitaciones sin responder"}
          <ChevronRight className="size-4" />
        </Link>
      )}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Hoy</div>
        {todays.length > 0 ? (
          <ul className="space-y-1.5">{todays.map(row)}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nada agendado.</p>
        )}
      </div>
      {tomorrows.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Mañana
          </div>
          <ul className="space-y-1.5">{tomorrows.map(row)}</ul>
        </div>
      )}
      <Link
        href="/agenda"
        className="flex items-center justify-center gap-2 rounded-2xl border py-2.5 text-sm font-medium hover:bg-muted"
      >
        <CalendarDays className="size-4 text-primary" /> Ver agenda completa
      </Link>
    </div>
  );
}
