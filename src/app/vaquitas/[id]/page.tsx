"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronRight, HandCoins, Plus, Receipt, Scale, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { VaquitaExpenseForm } from "@/components/vaquitas/expense-form";
import { VaquitaPaymentForm } from "@/components/vaquitas/payment-form";
import { VaquitaSettings } from "@/components/vaquitas/settings-panel";
import { ddmm } from "@/components/vaquitas/shared";
import { ENTER, enterDelay } from "@/components/motion/enter";
import { useAuth } from "@/hooks/use-auth";
import { useFxRates } from "@/hooks/use-fx-rates";
import { useVaquita, useVaquitaExpenses, useVaquitaPayments } from "@/hooks/use-vaquitas";
import {
  carriedShares,
  firstName,
  summarizeVaquita,
  toVaquitaCurrency,
  unitOfMember,
  type Settlement,
  type Vaquita,
  type VaquitaExpense,
  type VaquitaPayment,
} from "@/lib/domain/vaquitas";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

type SheetState =
  | { type: "expense"; expense: VaquitaExpense | null }
  | { type: "payment"; payment: VaquitaPayment | null; defaults?: { from?: string; to?: string; amount?: number } }
  | { type: "settings" }
  | null;

const round2 = (n: number) => Math.round(n * 100) / 100;

export default function VaquitaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();
  const { data: v, missing, loading } = useVaquita(id);
  const { data: expenses } = useVaquitaExpenses(id, !!v);
  const { data: payments } = useVaquitaPayments(id, !!v);
  const fx = useFxRates();
  const [sheet, setSheet] = useState<SheetState>(null);

  const summary = useMemo(() => (v ? summarizeVaquita(v, expenses, payments) : null), [v, expenses, payments]);

  if (missing) {
    return (
      <div className="space-y-3">
        <Link href="/vaquitas" className="inline-flex items-center text-sm text-muted-foreground">
          <ArrowLeft className="mr-1 size-4" /> Vaquitas
        </Link>
        <p className="text-sm">Esta vaquita ya no existe o no participás.</p>
      </div>
    );
  }
  if (loading || !v || !summary || !user) return <p className="text-sm text-muted-foreground">Cargando…</p>;

  const me = v.members.find((m) => m.uid === user.uid) ?? null;
  const unitOf = unitOfMember(summary.units);
  const myUnit = summary.units.find((u) => u.id === (me ? unitOf.get(me.id) : ""));
  const name = (memberId: string) => {
    const m = v.members.find((x) => x.id === memberId);
    return m?.uid === user.uid ? "Vos" : firstName(m?.name ?? "Alguien");
  };
  const unitLabel = (unitId: string) => {
    const u = summary.units.find((x) => x.id === unitId);
    if (!u) return "—";
    if (u.isFamily) return u.name;
    return name(u.memberIds[0]);
  };
  // Lo que va a mis gastos (en la moneda de la vaquita).
  const myBooks = round2(
    expenses.reduce((s, e) => s + toVaquitaCurrency(carriedShares(v, e).get(user.uid) ?? 0, e.rate), 0),
  );
  const pesos = v.currency !== "ARS" && fx?.rates[v.currency] ? round2(summary.total * fx.rates[v.currency]!) : null;
  const closed = v.status === "closed";

  // Integrante para registrar un pago de una parte: yo si estoy, si no alguien con la app.
  const repOf = (unitId: string) => {
    const u = summary.units.find((x) => x.id === unitId);
    if (!u) return undefined;
    if (me && u.memberIds.includes(me.id)) return me.id;
    return u.memberIds.find((mid) => v.members.find((m) => m.id === mid)?.uid) ?? u.memberIds[0];
  };
  const payFor = (s: Settlement) =>
    setSheet({ type: "payment", payment: null, defaults: { from: repOf(s.fromUnit), to: repOf(s.toUnit), amount: s.amount } });

  const net = myUnit?.net ?? 0;
  const who = myUnit?.isFamily ? "Tu familia" : "Vos";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <Link href="/vaquitas" className="inline-flex items-center text-sm text-muted-foreground">
          <ArrowLeft className="mr-1 size-4" /> Vaquitas
        </Link>
        <Button variant="ghost" size="sm" onClick={() => setSheet({ type: "settings" })}>
          <Settings2 className="mr-1 size-4" /> Ajustes
        </Button>
      </div>

      <Card className="overflow-hidden rounded-3xl border-0 bg-brand-grad text-white">
        <CardContent className="space-y-4 py-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{v.name}</h1>
            <p className="text-sm opacity-80">
              {v.families.length > 0
                ? v.families.map((f) => f.name).join(" · ")
                : v.members.map((m) => (m.uid === user.uid ? "Vos" : firstName(m.name))).join(", ")}
              {closed && " · cerrada"}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider opacity-80">Gastaron</div>
              <div className="text-xl font-semibold tabular-nums">{formatMoney(summary.total, v.currency)}</div>
              {pesos != null && <div className="text-xs opacity-80">≈ {formatMoney(pesos, "ARS")} hoy</div>}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider opacity-80">A tus gastos</div>
              <div className="text-xl font-semibold tabular-nums">{formatMoney(myBooks, v.currency)}</div>
              {v.currency !== "ARS" && fx?.rates[v.currency] && (
                <div className="text-xs opacity-80">≈ {formatMoney(round2(myBooks * fx.rates[v.currency]!), "ARS")} hoy</div>
              )}
            </div>
          </div>
          {myUnit && (
            <div className="rounded-2xl bg-white/15 px-3 py-2 text-sm font-medium">
              {Math.abs(net) < 0.01
                ? expenses.length
                  ? `${who} ${myUnit.isFamily ? "está" : "estás"} a mano`
                  : "Todavía no hay gastos"
                : net > 0
                  ? `${who} ${myUnit.isFamily ? "tiene" : "tenés"} que recibir ${formatMoney(net, v.currency)}`
                  : `${who} ${myUnit.isFamily ? "debe" : "debés"} ${formatMoney(-net, v.currency)}`}
            </div>
          )}
        </CardContent>
      </Card>

      {!closed && (
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-12 bg-brand-grad text-white hover:opacity-95" onClick={() => setSheet({ type: "expense", expense: null })}>
            <Plus className="mr-1 size-4" /> Gasto
          </Button>
          <Button variant="outline" className="h-12" onClick={() => setSheet({ type: "payment", payment: null })}>
            <HandCoins className="mr-1 size-4" /> Pago
          </Button>
        </div>
      )}

      {summary.settlements.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <HandCoins className="size-4" /> Quién le paga a quién
            </CardTitle>
            <p className="text-xs text-muted-foreground">La menor cantidad de pagos para quedar a mano.</p>
          </CardHeader>
          <CardContent className="divide-y">
            {summary.settlements.map((s, i) => {
              const mine = myUnit && (s.fromUnit === myUnit.id || s.toUnit === myUnit.id);
              return (
                <div key={`${s.fromUnit}-${s.toUnit}`} className={cn("flex items-center gap-2 py-3", ENTER)} style={enterDelay(i)}>
                  <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sm", mine && "font-semibold")}>
                    <span className="truncate">{unitLabel(s.fromUnit)}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{unitLabel(s.toUnit)}</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{formatMoney(s.amount, v.currency)}</span>
                  {!closed && (
                    <Button size="sm" variant="outline" onClick={() => payFor(s)}>
                      Pagado
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {expenses.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <Scale className="size-4" /> Saldos
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {summary.units.map((u) => (
              <div key={u.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{unitLabel(u.id)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {u.isFamily && `${u.memberIds.map(name).join(", ")} · `}
                    puso {formatMoney(u.paid, v.currency)} · le tocaba {formatMoney(u.share, v.currency)}
                    {(u.sent > 0 || u.received > 0) &&
                      ` · ${u.sent > 0 ? `pagó ${formatMoney(u.sent, v.currency)}` : `recibió ${formatMoney(u.received, v.currency)}`}`}
                  </div>
                </div>
                <span
                  className={cn(
                    "text-right text-sm font-semibold tabular-nums",
                    u.net > 0.009 ? "text-success" : u.net < -0.009 ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {Math.abs(u.net) < 0.01 ? "a mano" : `${u.net > 0 ? "+" : "−"}${formatMoney(Math.abs(u.net), v.currency)}`}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="rounded-3xl">
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
            <Receipt className="size-4" /> Gastos
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {expenses.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Cargá lo que va pagando cada uno. Lo ven y lo editan todos los que usan la app.
            </p>
          )}
          {expenses.map((e, i) => (
            <ExpenseRow key={e.id} v={v} e={e} index={i} uid={user.uid} name={name} onOpen={() => setSheet({ type: "expense", expense: e })} />
          ))}
        </CardContent>
      </Card>

      {payments.length > 0 && (
        <Card className="rounded-3xl">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <HandCoins className="size-4" /> Pagos entre ustedes
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {payments.map((p, i) => {
              const fromM = v.members.find((m) => m.id === p.from);
              const toM = v.members.find((m) => m.id === p.to);
              const party = fromM?.uid === user.uid || toM?.uid === user.uid;
              const noAccount = party && !p.legs?.[user.uid];
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSheet({ type: "payment", payment: p })}
                  className={cn("flex w-full items-center gap-3 py-3 text-left hover:opacity-80", ENTER)}
                  style={enterDelay(i)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {name(p.from)} <ArrowRight className="size-3.5 text-muted-foreground" /> {name(p.to)}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {ddmm(p.date)}
                      {p.note && ` · ${p.note}`}
                    </div>
                    {noAccount && (
                      <span className="mt-1 inline-block rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                        Elegí la cuenta para tus cuentas
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums">{formatMoney(p.amount, p.currency)}</div>
                    {p.currency !== v.currency && (
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {formatMoney(toVaquitaCurrency(p.amount, p.rate), v.currency)}
                      </div>
                    )}
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Sheet open={!!sheet} onOpenChange={(o) => !o && setSheet(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>
              {sheet?.type === "expense"
                ? sheet.expense
                  ? "Editar gasto"
                  : "Nuevo gasto"
                : sheet?.type === "payment"
                  ? sheet.payment
                    ? "Pago"
                    : "Registrar pago"
                  : "Ajustes de la vaquita"}
            </SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {sheet?.type === "expense" && (
              <VaquitaExpenseForm key={sheet.expense?.id ?? "new"} vaquita={v} expense={sheet.expense} onDone={() => setSheet(null)} />
            )}
            {sheet?.type === "payment" && (
              <VaquitaPaymentForm
                key={sheet.payment?.id ?? "new"}
                vaquita={v}
                payment={sheet.payment}
                defaults={sheet.defaults}
                onDone={() => setSheet(null)}
              />
            )}
            {sheet?.type === "settings" && <VaquitaSettings vaquita={v} onClose={() => setSheet(null)} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ExpenseRow({
  v,
  e,
  index,
  uid,
  name,
  onOpen,
}: {
  v: Vaquita;
  e: VaquitaExpense;
  index: number;
  uid: string;
  name: (memberId: string) => string;
  onOpen: () => void;
}) {
  const payers = Object.keys(e.paidBy ?? {});
  const me = v.members.find((m) => m.uid === uid);
  const iPaid = !!me && (e.paidBy?.[me.id] ?? 0) > 0;
  const mine = carriedShares(v, e).get(uid) ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("flex w-full items-center gap-3 py-3 text-left hover:opacity-80", ENTER)}
      style={enterDelay(index)}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{e.description}</div>
        <div className="truncate text-xs text-muted-foreground">
          {ddmm(e.date)} · {payers.length === 1 ? `pagó ${name(payers[0])}` : `pagaron ${payers.map(name).join(" y ")}`}
          {mine > 0 && ` · a tus gastos ${formatMoney(mine, e.currency)}`}
        </div>
        {iPaid && !e.legs?.[uid] && (
          <span className="mt-1 inline-block rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
            Elegí con qué pagaste para tus cuentas
          </span>
        )}
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold tabular-nums">{formatMoney(e.amount, e.currency)}</div>
        {e.currency !== v.currency && (
          <div className="text-[11px] text-muted-foreground tabular-nums">{formatMoney(toVaquitaCurrency(e.amount, e.rate), v.currency)}</div>
        )}
      </div>
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}
