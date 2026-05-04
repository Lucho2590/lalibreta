"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import {
  useSharedAsOwner,
  useSharedAsParticipant,
} from "@/hooks/use-data";
import { formatCurrency, formatDate } from "@/lib/format";
import type { SharedExpense } from "@/lib/domain/types";

export default function CompartidasPage() {
  const { user } = useAuth();
  const { data: ownerSide, loading: l1 } = useSharedAsOwner();
  const { data: participantSide, loading: l2 } = useSharedAsParticipant();

  // Eliminar duplicados (al ser owner también aparece como participant si
  // está incluido en participantUids).
  const participantOnly = useMemo(
    () => participantSide.filter((s) => s.ownerUid !== user?.uid),
    [participantSide, user?.uid],
  );

  const balances = useMemo(
    () => computeBalances(user?.uid ?? "", ownerSide, participantOnly),
    [ownerSide, participantOnly, user?.uid],
  );

  const loading = l1 || l2;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Compartidas</h1>
        <p className="text-sm text-muted-foreground">
          Gastos divididos con otra gente
        </p>
      </div>

      {/* Balance summary */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="rounded-2xl">
          <CardContent className="flex items-center gap-3 py-4">
            <div className="flex size-10 items-center justify-center rounded-xl bg-success/10 text-success">
              <ArrowDownLeft className="size-5" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Te deben
              </div>
              <div className="text-xl font-semibold tabular-nums text-success">
                {formatCurrency(balances.totalOwedToYou)}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="flex items-center gap-3 py-4">
            <div className="flex size-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <ArrowUpRight className="size-5" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Le debés
              </div>
              <div className="text-xl font-semibold tabular-nums text-destructive">
                {formatCurrency(balances.totalYouOwe)}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Por persona */}
      {balances.perPerson.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Por persona</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {balances.perPerson.map((p) => (
              <div
                key={p.email}
                className="flex items-center justify-between rounded-xl px-2 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {p.displayName || p.email}
                  </div>
                  {p.displayName && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {p.email}
                    </div>
                  )}
                </div>
                <div
                  className={`text-sm font-semibold tabular-nums ${
                    p.net > 0
                      ? "text-success"
                      : p.net < 0
                        ? "text-destructive"
                        : ""
                  }`}
                >
                  {p.net > 0
                    ? `+${formatCurrency(p.net)}`
                    : p.net < 0
                      ? `-${formatCurrency(Math.abs(p.net))}`
                      : formatCurrency(0)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {/* Compartidos por mí */}
      <Section
        title="Compartidos por vos"
        items={ownerSide}
        currentUid={user?.uid ?? ""}
        viewerIsOwner
      />

      {/* Compartidos conmigo */}
      <Section
        title="Te compartieron"
        items={participantOnly}
        currentUid={user?.uid ?? ""}
        viewerIsOwner={false}
      />

      {!loading &&
        ownerSide.length === 0 &&
        participantOnly.length === 0 && (
          <Card className="rounded-3xl">
            <CardContent className="py-16 text-center">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
                <Users className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">Sin gastos compartidos todavía</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Al cargar un gasto, activá &quot;Compartirlo con alguien&quot; y elegí los contactos.
              </p>
            </CardContent>
          </Card>
        )}
    </div>
  );
}

function Section({
  title,
  items,
  currentUid,
  viewerIsOwner,
}: {
  title: string;
  items: SharedExpense[];
  currentUid: string;
  viewerIsOwner: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="space-y-2">
        {items.map((s) => (
          <Link key={s.id} href={`/compartidas/${s.id}`}>
            <Card className="rounded-2xl transition hover:shadow-sm active:scale-[0.99]">
              <CardContent className="flex items-center gap-3 py-3.5">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                  <Users className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">
                      {s.description || "Gasto compartido"}
                    </span>
                    <StatusChip
                      sharedExpense={s}
                      currentUid={currentUid}
                      viewerIsOwner={viewerIsOwner}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(s.date.toDate())} ·{" "}
                    {viewerIsOwner
                      ? `${s.participants.length} ${s.participants.length === 1 ? "participante" : "participantes"}`
                      : `de ${s.ownerDisplayName || s.ownerEmail}`}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums">
                  {formatCurrency(s.totalAmount)}
                </div>
                <ChevronRight className="size-4 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

function StatusChip({
  sharedExpense,
  currentUid,
  viewerIsOwner,
}: {
  sharedExpense: SharedExpense;
  currentUid: string;
  viewerIsOwner: boolean;
}) {
  if (sharedExpense.status === "cancelled") {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        Cancelado
      </span>
    );
  }
  if (viewerIsOwner) {
    const others = sharedExpense.participants.filter((p) => p.status !== "owner");
    const allAccepted = others.every((p) => p.status === "accepted");
    const anyRejected = others.some((p) => p.status === "rejected");
    if (anyRejected) {
      return (
        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
          Con rechazos
        </span>
      );
    }
    if (allAccepted) {
      return (
        <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
          Aceptado
        </span>
      );
    }
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        Pendiente
      </span>
    );
  }
  const me = sharedExpense.participants.find((p) => p.uid === currentUid);
  if (!me) return null;
  if (me.status === "accepted") {
    return (
      <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
        Aceptado
      </span>
    );
  }
  if (me.status === "rejected") {
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
        Rechazado
      </span>
    );
  }
  return (
    <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand">
      Te toca responder
    </span>
  );
}

interface PerPersonBalance {
  email: string;
  displayName: string | null;
  net: number; // > 0 te deben, < 0 le debés
}

function computeBalances(
  currentUid: string,
  asOwner: SharedExpense[],
  asParticipant: SharedExpense[],
) {
  const map = new Map<string, PerPersonBalance>();

  // Cuando soy owner: cada participante aceptado me debe su monto.
  for (const s of asOwner) {
    if (s.status === "cancelled") continue;
    for (const p of s.participants) {
      if (p.status !== "accepted") continue;
      const key = p.email;
      const cur = map.get(key) ?? { email: p.email, displayName: p.displayName ?? null, net: 0 };
      cur.net += p.amount;
      map.set(key, cur);
    }
  }
  // Cuando soy participant: si acepté, le debo mi monto al owner.
  for (const s of asParticipant) {
    if (s.status === "cancelled") continue;
    const me = s.participants.find((p) => p.uid === currentUid);
    if (!me || me.status !== "accepted") continue;
    const key = s.ownerEmail;
    const cur = map.get(key) ?? { email: s.ownerEmail, displayName: s.ownerDisplayName ?? null, net: 0 };
    cur.net -= me.amount;
    map.set(key, cur);
  }

  const perPerson = [...map.values()].filter((p) => p.net !== 0);
  perPerson.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const totalOwedToYou = perPerson.reduce((s, p) => s + Math.max(0, p.net), 0);
  const totalYouOwe = perPerson.reduce((s, p) => s + Math.max(0, -p.net), 0);

  return { perPerson, totalOwedToYou, totalYouOwe };
}
