"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, ChevronDown, CreditCard, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAccounts, useCategories, useConnections, useContacts } from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { deleteTransactionAndInstallments } from "@/lib/domain/installments";
import type { Installment } from "@/lib/domain/types";
import { formatMoney, formatShortDate } from "@/lib/format";
import { currencyOf } from "@/lib/domain/types";
import { CategoryIcon } from "@/components/category-icon";
import type { SharedAdjustment } from "@/lib/domain/balance";
import { otherUid, personRefFromAccountId, profileName } from "@/lib/domain/people";
import { apiPost, errorText } from "@/lib/api";
import { isPersonAccountId } from "@/lib/domain/people";
import { SplitExistingSheet } from "@/components/people/split-existing";

interface Props {
  items: Installment[];
  /** Gastos repartidos: muestra mi parte y con quién se repartió. */
  adjustment?: SharedAdjustment;
  /**
   * Lista de UNA cuenta: las transferencias se muestran como entrada (+) o
   * salida (−) de esa cuenta en vez de neutras.
   */
  perspectiveAccountId?: string;
  /** Agrupa los consumos de cada tarjeta en una fila desplegable (default: sí). */
  groupCards?: boolean;
}

export function TransactionList({
  items,
  adjustment,
  perspectiveAccountId,
  groupCards = true,
}: Props) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  // Nombres de personas (para "Le debés a…" y transferencias con gente).
  const { data: connections } = useConnections();
  const { data: contacts } = useContacts();
  const personName = useMemo(() => {
    const names = new Map<string, string>();
    for (const c of connections) {
      if (!user) continue;
      const uid = otherUid(c, user.uid);
      names.set(`u:${uid}`, profileName(c.profiles?.[uid]));
    }
    for (const c of contacts) names.set(`c:${c.id}`, c.displayName || c.email || "Contacto");
    return (accountId: string | null | undefined) => {
      const ref = personRefFromAccountId(accountId);
      return ref ? (names.get(ref) ?? "una persona") : null;
    };
  }, [connections, contacts, user]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Gasto ya cargado que se va a dividir con otras personas.
  const [splitting, setSplitting] = useState<Installment | null>(null);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async (it: Installment) => {
    if (!user) return;
    const split = it.kind === "expense" ? adjustment?.byTxId.get(it.transactionId)?.split : undefined;
    try {
      // Gasto mío repartido: se cancela el reparto (y se les avisa).
      if (split) {
        const names = split.participants.map((p) => p.name).join(", ");
        if (!confirm(`Este gasto está repartido con ${names}. Si lo borrás, se cancela el reparto y se les avisa. ¿Borrarlo?`)) return;
        await apiPost("/api/splits/cancel", { splitId: split.id, deleteOwnerTx: true });
        toast.success("Gasto borrado y reparto cancelado");
        return;
      }
      // Mi parte de un gasto que pagó otro: se saca de mis gastos (la deuda sigue).
      if (it.splitId) {
        if (!confirm("Es tu parte de un gasto que pagó otra persona. ¿Sacarla de tus gastos? (lo que le debés no cambia)")) return;
        await apiPost("/api/splits/books", { splitId: it.splitId, addToBooks: false });
        toast.success("Lo sacaste de tus gastos");
        return;
      }
      // Transferencia con una persona: se borra para los dos.
      if (it.p2pTransferId) {
        if (!confirm("Se borra para las dos personas y deja de contar para lo que se deben. ¿Borrarla?")) return;
        await apiPost("/api/people/transfers/cancel", { id: it.p2pTransferId });
        toast.success("Transferencia borrada");
        return;
      }
      if (!confirm("¿Eliminar este movimiento?")) return;
      await deleteTransactionAndInstallments(user.uid, it.transactionId);
      toast.success("Eliminado");
    } catch (err) {
      toast.error(errorText(err));
      console.error(err);
    }
  };

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Sin movimientos en este mes.
        </CardContent>
      </Card>
    );
  }

  // Transferencias: una sola entrada por transacción (la de origen si está;
  // si la lista es de la cuenta destino, la de destino). Guardamos la otra pata
  // para mostrar los cambios de moneda (US$ 500 → $ 740.000).
  const legsByTx = new Map<string, typeof items>();
  for (const i of items) {
    if (i.kind !== "transfer") continue;
    legsByTx.set(i.transactionId, [...(legsByTx.get(i.transactionId) ?? []), i]);
  }
  const dedup = items.filter((i) => {
    if (i.kind !== "transfer") return true;
    const legs = legsByTx.get(i.transactionId) ?? [];
    return i.transferRole === "source" || !legs.some((l) => l.transferRole === "source");
  });
  const sorted = [...dedup].sort(
    (a, b) => b.billingDate.toMillis() - a.billingDate.toMillis(),
  );


  const renderRow = (it: Installment, nested = false) => {
      const acc = accountMap.get(it.accountId);
      const cat = categoryMap.get(it.categoryId);
      const isTransfer = it.kind === "transfer";
      const counterpart = isTransfer
        ? accountMap.get(it.transferCounterpartId ?? "")
        : null;
      const cur = currencyOf(it);
      const otherLeg = isTransfer
        ? legsByTx.get(it.transactionId)?.find((l) => l.id !== it.id)
        : undefined;
      const isExchange = it.transferType === "exchange" || (otherLeg && currencyOf(otherLeg) !== cur);
      const isCardPayment = it.transferType === "card-payment";
      const isP2P = it.transferType === "p2p";
      // Persona: la contraparte de una transferencia con gente, o a quién le debo mi parte.
      const person = isP2P ? personName(it.transferCounterpartId) : personName(it.accountId);
      // Cotización del cambio (pesos por dólar), a partir de las dos patas.
      const exchangeRate =
        isExchange && otherLeg
          ? (() => {
              const usdLeg = cur === "USD" ? it : otherLeg;
              const arsLeg = cur === "USD" ? otherLeg : it;
              return usdLeg.amount > 0 ? arsLeg.amount / usdLeg.amount : null;
            })()
          : null;
      const transferLabel = isCardPayment
        ? "Pago de tarjeta"
        : isP2P
          ? it.transferRole === "destination"
            ? "Me pasó"
            : "Le pasé"
          : isExchange
            ? "Cambio"
            : "Transferencia";
      // Mirando una cuenta: ¿esta pata entró o salió de ella? (un cambio dentro
      // de la misma cuenta sigue mostrándose como "US$ → $").
      // Con una persona siempre se ve si entró o salió.
      const flowSign =
        isTransfer &&
        (isP2P ||
          (perspectiveAccountId &&
            it.accountId === perspectiveAccountId &&
            !(otherLeg && otherLeg.accountId === it.accountId)))
          ? it.transferRole === "destination"
            ? "+"
            : "−"
          : null;
      const counterpartName = isP2P ? person : counterpart?.name;
      const [fromName, toName] =
        it.transferRole === "destination"
          ? [counterpartName, acc?.name]
          : [acc?.name, counterpartName];

      // Gasto mío repartido: muestro mi parte (y el total tachado).
      const splitInfo = it.kind === "expense" ? adjustment?.byTxId.get(it.transactionId) : undefined;
      const displayAmount = splitInfo ? Math.round(it.amount * splitInfo.factor * 100) / 100 : it.amount;
      const showDiff = !!splitInfo && Math.abs(displayAmount - it.amount) >= 0.01;

      return (
        <Card key={it.id} className={`rounded-2xl transition hover:shadow-sm ${nested ? "bg-muted/20 shadow-none" : ""}`}>
          <CardContent className="flex items-center gap-3 py-3.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
              {isTransfer ? (
                <ArrowLeftRight className="size-5" />
              ) : (
                <CategoryIcon name={cat?.icon} className="size-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">
                  {it.description ||
                    (isTransfer
                      ? transferLabel
                      : cat?.name || "Movimiento")}
                </span>
                {isTransfer && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {transferLabel}
                  </span>
                )}
                {it.cardCredit && (
                  <span
                    className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success"
                    title="Reintegro en la tarjeta: baja lo que tenés que pagar"
                  >
                    saldo a favor
                  </span>
                )}
                {it.projected && (
                  <span
                    className="rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                    title="Suscripción estimada: se reemplaza por el monto real al importar el resumen"
                  >
                    estimado
                  </span>
                )}
                {it.createdByName && (
                  <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                    {it.createdByName}
                  </span>
                )}
                {!isTransfer && it.totalInstallments > 1 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {it.installmentNumber}/{it.totalInstallments}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {isTransfer
                  ? `${fromName === toName ? (fromName ?? "—") : `${fromName ?? "—"} → ${toName ?? "—"}`}${!isCardPayment && exchangeRate ? ` · a ${formatMoney(Math.round(exchangeRate * 100) / 100, "ARS")}` : ""} · ${formatShortDate(it.billingDate.toDate())}`
                  : `${cat?.name ?? "—"} · ${person ? `Pagó ${person} (le debés tu parte)` : (acc?.name ?? "—")} · ${formatShortDate(it.billingDate.toDate())}`}
              </div>
              {splitInfo && (
                <Link
                  href={`/compartidas/gasto/${splitInfo.split.id}`}
                  className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/20"
                >
                  <Users className="size-3" />
                  Dividido con {splitInfo.split.participants.map((p) => p.name.split(" ")[0]).join(", ")}
                  {splitInfo.pendingCount > 0
                    ? ` · ${splitInfo.pendingCount} sin responder`
                    : splitInfo.rejectedCount > 0
                      ? ` · ${splitInfo.rejectedCount} no aceptó`
                      : ""}
                </Link>
              )}
              {it.splitId && (
                <Link
                  href={`/compartidas/gasto/${it.splitId}`}
                  className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/20"
                >
                  <Users className="size-3" />
                  Tu parte de un gasto compartido
                </Link>
              )}
            </div>
            <div className="flex flex-col items-end">
              <div
                className={`text-sm font-semibold tabular-nums ${
                  it.kind === "income" || flowSign === "+"
                    ? "text-success"
                    : isTransfer && !flowSign
                      ? "text-muted-foreground"
                      : ""
                }`}
              >
                {flowSign
                  ? `${flowSign}${formatMoney(it.amount, cur)}`
                  : isTransfer
                  ? isExchange && otherLeg
                    ? `${formatMoney(it.transferRole === "destination" ? otherLeg.amount : it.amount, it.transferRole === "destination" ? currencyOf(otherLeg) : cur)} → ${formatMoney(it.transferRole === "destination" ? it.amount : otherLeg.amount, it.transferRole === "destination" ? cur : currencyOf(otherLeg))}`
                    : formatMoney(it.amount, cur)
                  : it.kind === "income"
                    ? `+${formatMoney(displayAmount, cur)}`
                    : `-${formatMoney(displayAmount, cur)}`}
              </div>
              {isExchange && !!it.exchangeDiff && (
                <div
                  className={`text-[10px] font-medium tabular-nums ${it.exchangeDiff < 0 ? "text-destructive" : "text-success"}`}
                  title={
                    it.quotedRate
                      ? `Diferencia contra la cotización pactada (${formatMoney(it.quotedRate, "ARS")}): redondeo o comisión`
                      : "Diferencia por redondeo o comisión"
                  }
                >
                  dif. {it.exchangeDiff > 0 ? "+" : "−"}
                  {formatMoney(Math.abs(it.exchangeDiff), "ARS")}
                </div>
              )}
              {showDiff && (
                <div className="text-[10px] text-muted-foreground line-through tabular-nums">
                  {formatMoney(it.amount, cur)}
                </div>
              )}
            </div>
            {/* Dividir un gasto mío ya cargado (no repartido todavía). */}
            {adjustment &&
              it.kind === "expense" &&
              !splitInfo &&
              !it.splitId &&
              !it.projected &&
              !isPersonAccountId(it.accountId) && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setSplitting(it)}
                  aria-label="Dividir con otras personas"
                  title="Dividir con otras personas"
                >
                  <Users className="size-4" />
                </Button>
              )}
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => remove(it)}
              aria-label="Eliminar"
            >
              <Trash2 className="size-4" />
            </Button>
          </CardContent>
        </Card>
      );
  };

  // Consumos de tarjeta: una fila por tarjeta (el resumen del mes), desplegable.
  type Entry =
    | { type: "row"; it: Installment; at: number }
    | { type: "card"; accountId: string; items: Installment[]; at: number };
  const entries: Entry[] = [];
  const cardGroups = new Map<string, Installment[]>();
  for (const it of sorted) {
    const acc = accountMap.get(it.accountId);
    if (groupCards && acc?.type === "credit" && it.kind !== "transfer") {
      cardGroups.set(it.accountId, [...(cardGroups.get(it.accountId) ?? []), it]);
    } else {
      entries.push({ type: "row", it, at: it.billingDate.toMillis() });
    }
  }
  for (const [accountId, list] of cardGroups) {
    // Una sola línea no se agrupa.
    if (list.length === 1) entries.push({ type: "row", it: list[0], at: list[0].billingDate.toMillis() });
    else entries.push({ type: "card", accountId, items: list, at: Math.max(...list.map((i) => i.billingDate.toMillis())) });
  }
  entries.sort((a, b) => b.at - a.at);

  const groupTotal = (list: Installment[]) => {
    const t: Record<"ARS" | "USD", number> = { ARS: 0, USD: 0 };
    // Lo que cobra la tarjeta: montos enteros (aunque haya gastos repartidos).
    for (const i of list) t[currencyOf(i)] += i.kind === "income" ? -i.amount : i.amount;
    return t;
  };

  return (
    <div className="space-y-2">
      <SplitExistingSheet key={splitting?.id ?? "none"} item={splitting} onClose={() => setSplitting(null)} />
      {entries.map((e) => {
        if (e.type === "row") return renderRow(e.it);
        const acc = accountMap.get(e.accountId);
        const total = groupTotal(e.items);
        const isOpen = open.has(e.accountId);
        const due = e.items[0].billingDate.toDate();
        return (
          <div key={`card-${e.accountId}`} className="space-y-2">
            <Card className="rounded-2xl transition hover:shadow-sm">
              <CardContent className="py-0">
                <button
                  type="button"
                  onClick={() => toggle(e.accountId)}
                  className="flex w-full items-center gap-3 py-3.5 text-left"
                  aria-expanded={isOpen}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                    <CreditCard className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{acc?.name ?? "Tarjeta"}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {e.items.length} consumos
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Resumen · vence {formatShortDate(due)}
                    </div>
                  </div>
                  <div className="text-right text-sm font-semibold tabular-nums">
                    {(["ARS", "USD"] as const)
                      .filter((c) => c === "ARS" || Math.abs(total[c]) > 0.009)
                      .map((c) => (
                        <div key={c}>-{formatMoney(Math.round(total[c] * 100) / 100, c)}</div>
                      ))}
                  </div>
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
              </CardContent>
            </Card>
            {isOpen && (
              <div className="ml-4 space-y-2 border-l-2 border-muted pl-3">
                {e.items.map((it) => renderRow(it, true))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
