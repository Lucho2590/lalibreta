"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CalendarDays, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

/** En el inicio: lo de hoy y mañana, y las invitaciones sin responder. */
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
    <Link href="/agenda" className="block">
      <Card className="rounded-3xl transition hover:bg-muted/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <CalendarDays className="size-4 text-primary" /> Tu agenda
            {invites > 0 && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {invites} {invites === 1 ? "invitación" : "invitaciones"}
              </span>
            )}
            <ChevronRight className="ml-auto size-4 text-muted-foreground" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-1">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Hoy</div>
            {todays.length > 0 ? (
              <ul className="space-y-1">{todays.map(row)}</ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nada agendado.</p>
            )}
          </div>
          {tomorrows.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Mañana
              </div>
              <ul className="space-y-1">{tomorrows.map(row)}</ul>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
