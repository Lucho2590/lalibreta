"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronRight, HandCoins, Plus, Users } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { usePeopleLedger, useSplitRules } from "@/hooks/use-data";
import { useMonth } from "@/hooks/use-month";
import { participantSchedule } from "@/lib/domain/people";
import { formatMonth } from "@/lib/format";
import { apiPost, errorText } from "@/lib/api";
import { toast } from "sonner";
import { Repeat } from "lucide-react";
import { PendingInbox } from "@/components/people/pending-inbox";
import { PersonTransferForm } from "@/components/people/person-transfer-form";
import { ledgerTotal, ledgerTotals } from "@/lib/domain/debts";
import { personBalanceText } from "@/components/people/balance-text";
import type { Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

const CURS: Currency[] = ["ARS", "USD"];
const moneyLine = (m: Record<Currency, number>) =>
  CURS.filter((c) => Math.abs(m[c]) > 0.009)
    .map((c) => formatMoney(Math.abs(m[c]), c))
    .join(" + ") || formatMoney(0, "ARS");

export default function CuentasConGentePage() {
  const { user } = useAuth();
  // Lo que corresponde hasta el mes que se mira (arriba en la barra); lo de
  // después son cuotas que vienen.
  const { monthKey, year, month } = useMonth();
  const monthName = formatMonth(year, month);
  const { ledger, splits, loading } = usePeopleLedger(monthKey);
  const [open, setOpen] = useState(false);
  const { data: rules } = useSplitRules();
  const removeRule = async (id: string, label: string) => {
    if (!confirm(`¿Dejar de dividir siempre «${label}»? Lo que ya se dividió queda.`)) return;
    try {
      await apiPost("/api/splits/rules/delete", { id });
      toast.success("Listo");
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const people = useMemo(
    () =>
      [...ledger.values()].sort(
        (a, b) => Math.abs(ledgerTotal(b, "ARS")) - Math.abs(ledgerTotal(a, "ARS")) || a.name.localeCompare(b.name, "es"),
      ),
    [ledger],
  );
  const totals = useMemo(() => ledgerTotals(ledger.values()), [ledger]);
  // Gastos míos divididos que tienen cuota (o pago) en este mes, con lo que
  // le toca a la otra gente ESTE mes.
  const myThisMonth = useMemo(
    () =>
      splits
        .filter((s) => s.ownerUid === user?.uid && s.status === "active")
        .map((s) => {
          let others = 0;
          let k = 0;
          for (const p of s.participants) {
            if (p.status === "rejected") continue;
            const sched = participantSchedule(s, p.amount);
            const idx = sched.findIndex((c) => c.paymentMonth === monthKey);
            if (idx >= 0) {
              others += sched[idx].amount;
              k = sched.length > 1 ? idx + 1 : 0;
            }
          }
          const n = participantSchedule(s, s.totalAmount).length;
          return { s, others: Math.round(others * 100) / 100, cuota: k, cuotas: n };
        })
        .filter((x) => x.others > 0)
        .sort((a, b) => b.others - a.others),
    [splits, user, monthKey],
  );
  // Lo que me toca pagar a mí este mes de gastos de otros (la cuota del mes).
  const iPayThisMonth = useMemo(
    () =>
      splits
        .filter((s) => s.ownerUid !== user?.uid && s.status === "active")
        .map((s) => {
          const me = s.participants.find((p) => p.uid === user?.uid);
          if (!me || (me.status !== "accepted" && me.status !== "pending")) return null;
          const sched = participantSchedule(s, me.amount);
          const idx = sched.findIndex((c) => c.paymentMonth === monthKey);
          if (idx < 0) return null;
          return { s, amount: sched[idx].amount, cuota: sched.length > 1 ? idx + 1 : 0, cuotas: sched.length, total: me.amount, pending: me.status === "pending" };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.amount - a.amount),
    [splits, user, monthKey],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cuentas con gente</h1>
          <p className="text-sm text-muted-foreground">Gastos divididos, préstamos y lo que se deben</p>
        </div>
        <Button className="bg-brand-grad text-white hover:opacity-95" onClick={() => setOpen(true)}>
          <Plus className="mr-1 size-4" /> Registrar pago
        </Button>
      </div>

      <PendingInbox />

      <div className="grid gap-3 md:grid-cols-2">
        <Card className="rounded-2xl">
          <CardContent className="flex items-center gap-3 py-4">
            <div className="flex size-10 items-center justify-center rounded-xl bg-success/10 text-success">
              <ArrowDownLeft className="size-5" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Te deben · hasta {monthName}</div>
              <div className="text-xl font-semibold tabular-nums text-success">{moneyLine(totals.owedToMe)}</div>
              {(totals.laterToMe.ARS > 0.009 || totals.laterToMe.USD > 0.009) && (
                <div className="text-xs text-muted-foreground">+ {moneyLine(totals.laterToMe)} de cuotas que vienen</div>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="flex items-center gap-3 py-4">
            <div className="flex size-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <ArrowUpRight className="size-5" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Le debés · hasta {monthName}</div>
              <div className="text-xl font-semibold tabular-nums text-destructive">{moneyLine(totals.iOwe)}</div>
              {(totals.laterIOwe.ARS > 0.009 || totals.laterIOwe.USD > 0.009) && (
                <div className="text-xs text-muted-foreground">+ {moneyLine(totals.laterIOwe)} de cuotas que vienen</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-3xl">
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
            <Users className="size-4" /> Por persona
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {loading && <p className="py-2 text-xs text-muted-foreground">Cargando…</p>}
          {!loading && people.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Todavía no hay nada con nadie. Dividí un gasto al cargarlo, o registrá un pago o un préstamo.
              <div className="mt-2">
                <Link href="/contactos" className="font-medium text-brand underline">
                  Conectate o agregá gente en Contactos
                </Link>
              </div>
            </div>
          )}
          {people.map((l) => {
            const b = personBalanceText(l);
            return (
              <Link
                key={l.ref}
                href={`/compartidas/persona/${encodeURIComponent(l.ref)}`}
                className="flex items-center gap-3 py-3 hover:opacity-80"
              >
                <Avatar className="size-10">
                  <AvatarFallback>{l.name[0]?.toUpperCase() ?? "?"}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{l.name}</span>
                    {!l.isApp && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">sin app</span>
                    )}
                  </div>
                  {b.later && <div className="text-xs text-muted-foreground">+ {b.later}</div>}
                </div>
                <span
                  className={`text-right text-sm font-semibold tabular-nums ${
                    b.tone === "success" ? "text-success" : b.tone === "destructive" ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {b.text}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </Link>
            );
          })}
        </CardContent>
      </Card>

      {iPayThisMonth.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <HandCoins className="size-4" /> Te toca pagar en {monthName}
            </CardTitle>
            <p className="text-xs text-muted-foreground">Tu parte de gastos que pagó otra persona (en cuotas, la cuota del mes).</p>
          </CardHeader>
          <CardContent className="divide-y">
            {iPayThisMonth.map(({ s, amount, cuota, cuotas, total, pending }) => (
              <Link key={s.id} href={`/compartidas/gasto/${s.id}`} className="flex items-center gap-3 py-3 hover:opacity-80">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.description}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    pagó {s.ownerName.split(" ")[0]}
                    {cuota > 0 ? ` · cuota ${cuota}/${cuotas} · total ${formatMoney(total, s.currency)}` : ` · ${s.date.split("-").reverse().join("/")}`}
                    {pending && " · sin responder"}
                  </div>
                </div>
                <span className="text-right text-sm font-semibold tabular-nums text-destructive">
                  {formatMoney(amount, s.currency)}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </Link>
            ))}
            <div className="flex justify-between pt-2.5 text-sm font-semibold">
              <span>Total del mes</span>
              <span className="tabular-nums">
                {(["ARS", "USD"] as const)
                  .map((c) => ({ c, v: iPayThisMonth.filter((x) => x.s.currency === c).reduce((a, x) => a + x.amount, 0) }))
                  .filter((x) => x.v > 0.009)
                  .map((x) => formatMoney(Math.round(x.v * 100) / 100, x.c))
                  .join(" + ")}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {myThisMonth.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <HandCoins className="size-4" /> Gastos divididos de {monthName}
            </CardTitle>
            <p className="text-xs text-muted-foreground">Lo que le toca a la otra gente este mes (en cuotas, la cuota del mes).</p>
          </CardHeader>
          <CardContent className="divide-y">
            {myThisMonth.map(({ s, others, cuota, cuotas }) => {
              const pending = s.participants.filter((p) => p.status === "pending").length;
              const rejected = s.participants.filter((p) => p.status === "rejected").length;
              return (
                <Link key={s.id} href={`/compartidas/gasto/${s.id}`} className="flex items-center gap-3 py-3 hover:opacity-80">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.description}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      con {s.participants.map((p) => p.name.split(" ")[0]).join(", ")}
                      {cuota > 0 ? ` · cuota ${cuota}/${cuotas}` : ` · ${s.date.split("-").reverse().join("/")}`}
                      {` · total ${formatMoney(s.totalAmount, s.currency)}`}
                      {pending > 0 && ` · ${pending} sin responder`}
                      {rejected > 0 && ` · ${rejected} no aceptó`}
                    </div>
                  </div>
                  <span className="text-right text-sm font-semibold tabular-nums">
                    {formatMoney(others, s.currency)}
                    <span className="block text-[10px] font-normal text-muted-foreground">les toca</span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </Link>
              );
            })}
            <div className="flex justify-between pt-2.5 text-sm font-semibold">
              <span>Total que te toca cobrar este mes</span>
              <span className="tabular-nums text-success">
                {(["ARS", "USD"] as const)
                  .map((c) => ({ c, v: myThisMonth.filter((x) => x.s.currency === c).reduce((a, x) => a + x.others, 0) }))
                  .filter((x) => x.v > 0.009)
                  .map((x) => formatMoney(Math.round(x.v * 100) / 100, x.c))
                  .join(" + ")}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {rules.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <Repeat className="size-4" /> Se dividen siempre
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Cada vez que entra uno de estos gastos (cargado, por el bot, del resumen o estimado) se divide solo.
            </p>
          </CardHeader>
          <CardContent className="divide-y">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.participants
                      .map((p) => `${p.name.split(" ")[0]} ${p.shareType === "percent" ? `${p.value}%` : `$${p.value}`}`)
                      .join(" · ")}
                    {r.mode === "lump" ? " · todo junto" : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => removeRule(r.id, r.label)}>
                  Quitar
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Registrar pago o préstamo</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {open && <PersonTransferForm onSubmitted={() => setOpen(false)} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
