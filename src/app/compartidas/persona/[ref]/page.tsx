"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { ArrowLeft, ArrowLeftRight, HandCoins, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { usePeople, usePeopleLedger } from "@/hooks/use-data";
import { PersonTransferForm, type PersonDirection } from "@/components/people/person-transfer-form";
import { personBalanceText } from "@/components/people/balance-text";
import { apiPost, errorText } from "@/lib/api";
import { ledgerNow } from "@/lib/domain/debts";
import { useMonth } from "@/hooks/use-month";
import { formatMonth } from "@/lib/format";
import { participantSchedule, transferSide, type PersonRef, type Split } from "@/lib/domain/people";
import { CURRENCIES, type Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AnimatedMoney } from "@/components/motion/animated-money";
import { ENTER, enterDelay } from "@/components/motion/enter";
import { PersonBalanceText, PersonLaterText } from "@/components/people/person-balance";

const ddmm = (ymd: string) => ymd.split("-").reverse().join("/");
/** En cuotas: el monto de una cuota (si no, la parte entera). */
const perCuota = (s: Split, amount: number) => participantSchedule(s, amount)[0]?.amount ?? amount;
const cuotasText = (s: Split, amount: number) => {
  const n = participantSchedule(s, amount).length;
  return n > 1 ? ` · ${n} cuotas · total ${formatMoney(amount, s.currency)}` : "";
};

interface Row {
  key: string;
  kind: "split" | "transfer";
  id: string;
  date: string;
  title: string;
  detail: string;
  amount: number;
  currency: Currency;
  /** + me debe, − le debo. */
  pendingLabel?: string;
  canDelete?: boolean;
}

export default function PersonPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref: raw } = use(params);
  const ref = decodeURIComponent(raw) as PersonRef;
  const { user } = useAuth();
  const { data: people } = usePeople();
  const { monthKey, year, month } = useMonth();
  const { ledger, splits, transfers, loading } = usePeopleLedger(monthKey);
  const [sheet, setSheet] = useState<{ direction: PersonDirection; amount?: number; currency: Currency } | null>(null);

  const l = ledger.get(ref);
  const person = people.find((p) => p.ref === ref);
  const name = l?.name ?? person?.name ?? "Persona";
  const isApp = ref.startsWith("u:");
  const me = user?.uid ?? "";

  // Historial: lo confirmado (del ledger, agrupado por gasto) + lo pendiente con esta persona.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const l = ledger.get(ref);
    if (l) {
      const bySplit = new Map<string, Row>();
      const splitEntries = new Map<string, typeof l.entries>();
      for (const e of l.entries) {
        if (e.kind === "transfer") {
          const t = transfers.find((x) => x.id === e.id);
          out.push({
            key: `t-${e.id}`,
            kind: "transfer",
            id: e.id,
            date: e.date,
            title: e.description,
            detail: e.amount > 0 ? (t?.kind === "loan" ? "Le prestaste" : "Le pasaste") : "Te pasó",
            amount: e.amount,
            currency: e.currency,
            canDelete: true,
          });
          continue;
        }
        const k = `s-${e.id}-${e.currency}`;
        const list = splitEntries.get(k) ?? [];
        list.push(e);
        splitEntries.set(k, list);
      }
      // Gastos divididos: uno por gasto. En cuotas, el monto es la cuota del
      // mes que se mira (o la próxima), con "cuota k/n" y el total al lado.
      for (const [k, list] of splitEntries) {
        const e0 = list[0];
        const sorted = [...list].sort((x, y) => x.paymentMonth.localeCompare(y.paymentMonth));
        const total = Math.round(sorted.reduce((acc, x) => acc + x.amount, 0) * 100) / 100;
        const s = splits.find((x) => x.id === e0.id);
        const base = e0.amount > 0 ? "Su parte de un gasto tuyo" : "Tu parte de un gasto suyo";
        if (sorted.length === 1) {
          bySplit.set(k, { key: k, kind: "split", id: e0.id, date: s?.date ?? e0.date, title: e0.description, detail: base, amount: total, currency: e0.currency });
          continue;
        }
        let idx = sorted.findIndex((x) => x.paymentMonth === monthKey);
        const isThisMonth = idx >= 0;
        if (idx < 0) idx = sorted.findIndex((x) => x.paymentMonth > monthKey);
        const cuota = idx >= 0 ? sorted[idx] : sorted[sorted.length - 1];
        const n = idx >= 0 ? idx + 1 : sorted.length;
        bySplit.set(k, {
          key: k,
          kind: "split",
          id: e0.id,
          date: cuota.date,
          title: e0.description,
          detail: `${base} · cuota ${n}/${sorted.length}${isThisMonth ? "" : idx >= 0 ? " (la próxima)" : " (la última)"} · total ${formatMoney(Math.abs(total), e0.currency)}`,
          amount: cuota.amount,
          currency: e0.currency,
        });
      }
      out.push(...bySplit.values());
    }
    for (const s of splits) {
      if (s.status !== "active") continue;
      if (s.ownerUid === me) {
        const p = s.participants.find((x) => x.ref === ref);
        if (p && (p.status === "pending" || p.status === "rejected")) {
          out.push({
            key: `sp-${s.id}`,
            kind: "split",
            id: s.id,
            date: s.date,
            title: s.description,
            detail: `Su parte de un gasto tuyo${cuotasText(s, p.amount)}`,
            amount: perCuota(s, p.amount),
            currency: s.currency,
            pendingLabel: p.status === "pending" ? "sin responder" : "no aceptó",
          });
        }
      } else if (`u:${s.ownerUid}` === ref) {
        const p = s.participants.find((x) => x.uid === me);
        if (p?.status === "pending") {
          out.push({
            key: `sp-${s.id}`,
            kind: "split",
            id: s.id,
            date: s.date,
            title: s.description,
            detail: `Te asignó una parte${cuotasText(s, p.amount)}`,
            amount: -perCuota(s, p.amount),
            currency: s.currency,
            pendingLabel: "respondé",
          });
        }
      }
    }
    for (const t of transfers) {
      if (t.status !== "pending" && t.status !== "rejected") continue;
      const side = transferSide(t, me);
      if (!side || side.person !== ref) continue;
      out.push({
        key: `tp-${t.id}`,
        kind: "transfer",
        id: t.id,
        date: t.date,
        title: t.description,
        detail: side.direction === "out" ? "Le pasaste" : "Te pasó",
        amount: side.direction === "out" ? t.amount : -t.amount,
        currency: t.currency,
        pendingLabel:
          t.status === "rejected" ? "no la reconoció" : t.createdByUid === me ? "esperando que confirme" : "confirmala",
        canDelete: t.createdByUid === me || t.status === "rejected",
      });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }, [ledger, splits, transfers, me, ref, monthKey]);

  // "Me pagó" / "Le pagué" se precargan con lo de ahora (no con las cuotas que vienen).
  // Pesos, salvo que solo haya deuda en otra moneda.
  const owedBy = CURRENCIES.map((c) => ({ c, v: l ? ledgerNow(l, c).now : 0 }));
  const mainCur: Currency =
    Math.abs(owedBy[0].v) >= 0.01 ? "ARS" : (owedBy.find((x) => Math.abs(x.v) > 0)?.c ?? "ARS");
  const mainOwed = owedBy.find((x) => x.c === mainCur)?.v ?? 0;
  const balance = l ? personBalanceText(l) : null;

  const removeTransfer = async (id: string) => {
    if (!confirm("¿Borrar esta transferencia? Se borra para los dos y deja de contar para lo que se deben.")) return;
    try {
      await apiPost("/api/people/transfers/cancel", { id });
      toast.success("Transferencia borrada");
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <div className="space-y-6">
      <Link href="/compartidas" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 size-4" /> Cuentas con gente
      </Link>

      <div className="overflow-hidden rounded-3xl bg-brand-grad p-6 text-white shadow-lg">
        <div className="flex items-center gap-3">
          <Avatar className="size-12">
            <AvatarFallback className="bg-white/20 text-white">{name[0]?.toUpperCase() ?? "?"}</AvatarFallback>
          </Avatar>
          <div>
            <div className="text-xl font-bold">{name}</div>
            <div className="text-xs opacity-80">{isApp ? "Usa La Libreta" : "Sin la app"}</div>
          </div>
        </div>
        <div className="mt-5 text-2xl font-bold tabular-nums">
          {balance ? <PersonBalanceText balance={balance} /> : "Están a mano"}
        </div>
        <div className="mt-1 text-sm opacity-90">
          Hasta {formatMonth(year, month)}
          {balance?.later && (
            <>
              {" · + "}
              <PersonLaterText balance={balance} />
            </>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            className="bg-white text-foreground hover:bg-white/90"
            onClick={() => setSheet({ direction: "in", amount: mainOwed > 0 ? mainOwed : undefined, currency: mainCur })}
          >
            Me pagó
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="bg-white/15 text-white hover:bg-white/25"
            onClick={() => setSheet({ direction: "out", amount: mainOwed < 0 ? -mainOwed : undefined, currency: mainCur })}
          >
            Le pagué
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="bg-white/15 text-white hover:bg-white/25"
            onClick={() => setSheet({ direction: "loan", currency: "ARS" })}
          >
            Le presté
          </Button>
        </div>
      </div>

      <Card className="rounded-3xl">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-semibold">Historial</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {loading && <p className="py-2 text-xs text-muted-foreground">Cargando…</p>}
          {!loading && rows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">Todavía no hay nada con {name}.</p>
          )}
          {rows.map((r, i) => (
            <div key={r.key} className={cn("flex items-center gap-3 py-3", ENTER)} style={enterDelay(i)}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                {r.kind === "split" ? <HandCoins className="size-4" /> : <ArrowLeftRight className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                {r.kind === "split" ? (
                  <Link href={`/compartidas/gasto/${r.id}`} className="block truncate text-sm font-medium hover:underline">
                    {r.title}
                  </Link>
                ) : (
                  <div className="truncate text-sm font-medium">{r.title}</div>
                )}
                <div className="truncate text-xs text-muted-foreground">
                  {r.detail} · {ddmm(r.date)}
                  {r.pendingLabel && <span className="font-medium text-brand"> · {r.pendingLabel}</span>}
                </div>
              </div>
              <span
                className={`text-sm font-semibold tabular-nums ${r.pendingLabel ? "text-muted-foreground" : r.amount > 0 ? "text-success" : "text-destructive"}`}
                title={r.amount > 0 ? "Suma a lo que te debe" : "Baja lo que te debe / suma a lo que le debés"}
              >
                {r.amount > 0 ? "+" : "−"}
                <AnimatedMoney amounts={{ [r.currency]: Math.abs(r.amount) }} />
              </span>
              {r.canDelete && (
                <Button size="icon" variant="ghost" className="text-muted-foreground" aria-label="Borrar" onClick={() => removeTransfer(r.id)}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))}
          {rows.length > 0 && (
            <p className="pt-2.5 text-xs text-muted-foreground">
              + suma a lo que {name.split(" ")[0]} te debe · − lo baja (o es lo que le debés vos).
            </p>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!sheet} onOpenChange={(o) => !o && setSheet(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>
              {sheet?.direction === "in" ? `${name} te pagó` : sheet?.direction === "loan" ? `Le prestaste a ${name}` : `Le pagaste a ${name}`}
            </SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {sheet && (
              <PersonTransferForm
                key={`${sheet.direction}-${sheet.amount ?? 0}`}
                defaultPerson={ref}
                defaultDirection={sheet.direction}
                defaultAmount={sheet.amount}
                defaultCurrency={sheet.currency}
                onSubmitted={() => setSheet(null)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
