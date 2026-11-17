"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeftRight, Check, HandCoins, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts, useConnections, usePersonTransfers, useSplits } from "@/hooks/use-data";
import { apiPost, errorText } from "@/lib/api";
import { sortAccounts } from "@/lib/domain/accounts";
import { participantSchedule, profileName, transferSide, type PersonTransfer } from "@/lib/domain/people";
import { accountCurrencies } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

/** Lo que me mandaron y tengo que responder. */
export function usePendingForMe() {
  const { user } = useAuth();
  const { data: connections } = useConnections();
  const { data: splits } = useSplits();
  const { data: transfers } = usePersonTransfers();
  return useMemo(() => {
    const me = user?.uid ?? "";
    const conns = connections.filter((c) => c.status === "pending" && c.addresseeUid === me);
    const mySplits = splits.filter(
      (s) => s.status === "active" && s.ownerUid !== me && s.participants.some((p) => p.uid === me && p.status === "pending"),
    );
    const trs = transfers.filter((t) => t.status === "pending" && t.createdByUid !== me);
    return { connections: conns, splits: mySplits, transfers: trs, count: conns.length + mySplits.length + trs.length };
  }, [user, connections, splits, transfers]);
}

/** Confirmar una transferencia que registró la otra persona (eligiendo mi cuenta). */
function TransferToConfirm({ t }: { t: PersonTransfer }) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const side = user ? transferSide(t, user.uid) : null;
  const options = sortAccounts(
    accounts.filter(
      (a) => a.active !== false && a.type !== "credit" && (a.type !== "reserve" || accountCurrencies(a).includes(t.currency)),
    ),
  );
  const chosen = options.find((a) => a.id === accountId) ?? options.find((a) => a.isMain) ?? options[0];
  if (!side) return null;
  const incoming = side.direction === "in";

  const respond = async (accept: boolean) => {
    setBusy(true);
    try {
      await apiPost("/api/people/transfers/respond", { id: t.id, accept, accountId: chosen?.id ?? null });
      toast.success(accept ? "Confirmada" : "Le avisamos que no la reconocés");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 py-3">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <ArrowLeftRight className="size-4" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">{side.name}</span>{" "}
          {incoming ? "registró que te pasó" : "registró que le pasaste"}{" "}
          <span className="font-semibold">{formatMoney(t.amount, t.currency)}</span>
          <div className="text-xs text-muted-foreground">
            {t.description} · {t.date.split("-").reverse().join("/")}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-12">
        <Select value={chosen?.id ?? ""} onValueChange={(v) => setAccountId(v ?? "")}>
          <SelectTrigger className="h-9 min-w-40">
            <SelectValue
              placeholder={incoming ? "¿En qué cuenta entró?" : "¿De qué cuenta salió?"}
              items={options.map((a) => ({ value: a.id, label: a.name }))}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" disabled={busy || !chosen} onClick={() => respond(true)}>
          <Check className="mr-1 size-4" /> Confirmar
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => respond(false)}>
          No la reconozco
        </Button>
      </div>
    </div>
  );
}

/** Tarjeta "Para responder" (no se muestra si no hay nada). */
export function PendingInbox({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const pending = usePendingForMe();
  const [busyId, setBusyId] = useState<string | null>(null);
  if (pending.count === 0 || !user) return null;

  const respondConnection = async (id: string, accept: boolean) => {
    setBusyId(id);
    try {
      await apiPost("/api/connections/respond", { id, accept });
      toast.success(accept ? "Conectados" : "Solicitud rechazada");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="rounded-3xl ring-2 ring-brand/30">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">
          Para responder <span className="text-muted-foreground">· {pending.count}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        {pending.connections.map((c) => {
          const p = c.profiles[c.requesterUid];
          return (
            <div key={c.id} className="flex items-center gap-3 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                <UserPlus className="size-4" />
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">{profileName(p)}</span> quiere conectarse con vos
              </div>
              <Button size="sm" disabled={busyId === c.id} onClick={() => respondConnection(c.id, true)}>
                Aceptar
              </Button>
              <Button size="icon" variant="ghost" aria-label="Rechazar" disabled={busyId === c.id} onClick={() => respondConnection(c.id, false)}>
                <X className="size-4" />
              </Button>
            </div>
          );
        })}
        {pending.splits.map((s) => {
          const mine = s.participants.find((p) => p.uid === user.uid)!;
          const n = participantSchedule(s, mine.amount).length;
          return (
            <Link key={s.id} href={`/compartidas/gasto/${s.id}`} className="flex items-center gap-3 py-3 hover:opacity-80">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                <HandCoins className="size-4" />
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">{s.ownerName}</span> te asignó{" "}
                <span className="font-semibold">
                  {n > 1 ? `${n} cuotas de ${formatMoney(Math.round((mine.amount / n) * 100) / 100, s.currency)}` : formatMoney(mine.amount, s.currency)}
                </span>{" "}
                de {s.description}
              </div>
              <span className="text-xs font-medium text-brand">Responder</span>
            </Link>
          );
        })}
        {!compact && pending.transfers.map((t) => <TransferToConfirm key={t.id} t={t} />)}
        {compact && pending.transfers.length > 0 && (
          <Link href="/compartidas" className="flex items-center gap-3 py-3 text-sm hover:opacity-80">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
              <ArrowLeftRight className="size-4" />
            </span>
            <span className="flex-1">
              {pending.transfers.length} {pending.transfers.length === 1 ? "transferencia" : "transferencias"} para confirmar
            </span>
            <span className="text-xs font-medium text-brand">Ver</span>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
