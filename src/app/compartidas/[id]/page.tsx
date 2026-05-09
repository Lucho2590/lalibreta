"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { doc, onSnapshot } from "firebase/firestore";
import {
  ArrowLeft,
  Check,
  Mail,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { db } from "@/lib/firebase/client";
import { apiFetch } from "@/lib/api";
import {
  cancelSharedExpense,
  deleteSharedExpense,
  sharedExpensesCollectionPath,
} from "@/lib/domain/shared";
import type { SharedExpense } from "@/lib/domain/types";
import { formatCurrency, formatDate } from "@/lib/format";

export default function SharedExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { user } = useAuth();
  const [data, setData] = useState<SharedExpense | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ref = doc(db, `${sharedExpensesCollectionPath()}/${id}`);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setError("No existe");
          setData(null);
        } else {
          setData({ id: snap.id, ...(snap.data() as Omit<SharedExpense, "id">) });
          setError(null);
        }
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return unsub;
  }, [id]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }
  if (error || !data) {
    return (
      <div className="space-y-3">
        <Link href="/compartidas" className="inline-flex items-center text-sm text-muted-foreground">
          <ArrowLeft className="mr-1 size-4" /> Volver
        </Link>
        <p className="text-sm">No se pudo cargar este gasto compartido.</p>
      </div>
    );
  }

  const isOwner = data.ownerUid === user?.uid;
  const myEmail = user?.email?.toLowerCase() ?? "";
  const me =
    data.participants.find((p) => p.uid === user?.uid) ??
    data.participants.find(
      (p) => !p.uid && p.email.toLowerCase() === myEmail,
    );
  const canRespond = !!me && me.status === "pending" && !isOwner;

  const respond = async (response: "accepted" | "rejected") => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/shared/respond", {
        method: "POST",
        body: JSON.stringify({ sharedExpenseId: data.id, response }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text);
      }
      toast.success(response === "accepted" ? "Aceptado" : "Rechazado");
    } catch (err) {
      toast.error("No se pudo responder");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const resendInvites = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/shared/invite", {
        method: "POST",
        body: JSON.stringify({ sharedExpenseId: data.id }),
      });
      const j = (await r.json()) as {
        sent?: Array<{ email: string; ok: boolean; error?: string; loggedOnly?: boolean }>;
        error?: string;
      };
      console.log("[shared invite] respuesta", j);
      if (!r.ok) {
        toast.error(`Falló: ${j.error ?? r.status}`);
        return;
      }
      const sent = j.sent ?? [];
      const ok = sent.filter((x) => x.ok).length;
      const fail = sent.filter((x) => !x.ok);
      if (fail.length > 0) {
        toast.error(`${ok} ok, ${fail.length} con error. Mirá la consola.`);
        for (const f of fail) console.warn("[invite fail]", f.email, f.error);
      } else if (sent.some((x) => x.loggedOnly)) {
        toast.message(`Mails logueados a consola (${ok}).`);
      } else {
        toast.success(`Invitaciones reenviadas (${ok}/${sent.length})`);
      }
    } catch (err) {
      toast.error("No se pudo reenviar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!confirm("¿Cancelar este gasto compartido? Los participantes lo verán como cancelado.")) return;
    setBusy(true);
    try {
      await cancelSharedExpense(data.id);
      toast.success("Cancelado");
    } catch (err) {
      toast.error("No se pudo cancelar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("¿Eliminar este gasto compartido para siempre? El gasto en tu cuenta se mantiene.")) return;
    setBusy(true);
    try {
      await deleteSharedExpense(data.id);
      toast.success("Eliminado");
      window.location.href = "/compartidas";
    } catch (err) {
      toast.error("No se pudo eliminar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Link
        href="/compartidas"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" /> Compartidas
      </Link>

      <div className="overflow-hidden rounded-3xl bg-brand-grad p-6 text-white shadow-lg">
        <div className="text-[11px] uppercase tracking-wider opacity-80">
          {data.status === "cancelled" ? "Cancelado" : "Gasto compartido"}
        </div>
        <div className="mt-1 text-xl font-bold tracking-tight">
          {data.description || "Gasto compartido"}
        </div>
        <div className="mt-4 text-3xl font-bold tabular-nums md:text-4xl">
          {formatCurrency(data.totalAmount)}
        </div>
        <div className="mt-1 text-xs opacity-80">
          {formatDate(data.date.toDate())} · de {data.ownerDisplayName || data.ownerEmail}
        </div>
      </div>

      {canRespond && (
        <Card className="rounded-3xl border-brand/30">
          <CardContent className="space-y-3 py-4">
            <div className="text-sm font-semibold">Te toca responder</div>
            <p className="text-xs text-muted-foreground">
              Te corresponde <strong>{formatCurrency(me!.amount)}</strong> ({me!.percentage}%).
            </p>
            <div className="flex gap-2">
              <Button
                className="flex-1 bg-brand-grad text-white hover:opacity-95"
                onClick={() => respond("accepted")}
                disabled={busy}
              >
                <Check className="mr-1 size-4" /> Aceptar
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => respond("rejected")}
                disabled={busy}
              >
                <X className="mr-1 size-4" /> Rechazar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-3xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Participantes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.participants.map((p) => {
            const isMe =
              (p.uid && p.uid === user?.uid) ||
              (!p.uid && p.email.toLowerCase() === myEmail);
            return (
              <div
                key={p.email}
                className="flex items-center gap-3 rounded-xl px-2 py-2"
              >
                <Avatar className="size-9">
                  <AvatarFallback>
                    {(p.displayName?.[0] ?? p.email[0] ?? "?").toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {p.displayName || p.email}
                    {isMe && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        (vos)
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {p.percentage}% · {formatCurrency(p.amount)}
                  </div>
                </div>
                <ParticipantStatus status={p.status} />
              </div>
            );
          })}
        </CardContent>
      </Card>

      {isOwner && data.status !== "cancelled" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={resendInvites} disabled={busy}>
            <Mail className="mr-1 size-4" /> Reenviar invitaciones
          </Button>
          <Button variant="outline" onClick={cancel} disabled={busy}>
            <X className="mr-1 size-4" /> Cancelar gasto compartido
          </Button>
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={remove}
            disabled={busy}
          >
            <Trash2 className="mr-1 size-4" /> Eliminar
          </Button>
        </div>
      )}

      {isOwner && data.status !== "cancelled" && (
        <OwnerProjection shared={data} />
      )}
    </div>
  );
}

function OwnerProjection({ shared }: { shared: SharedExpense }) {
  const others = shared.participants.filter((p) => p.uid !== shared.ownerUid);
  const acceptedSum = others
    .filter((p) => p.status === "accepted")
    .reduce((s, p) => s + p.amount, 0);
  const pendingSum = others
    .filter((p) => p.status === "pending")
    .reduce((s, p) => s + p.amount, 0);
  const total = shared.totalAmount;
  const currentEffective = Math.max(0, total - acceptedSum);
  const bestCase = Math.max(0, currentEffective - pendingSum);
  const hasPending = pendingSum > 0;

  return (
    <Card className="rounded-2xl bg-muted/30">
      <CardContent className="space-y-2 py-3 text-xs text-muted-foreground">
        <div>
          Tu cuenta refleja{" "}
          <strong className="text-foreground">
            {formatCurrency(currentEffective)}
          </strong>{" "}
          — tu parte efectiva de este gasto (sobre un total de{" "}
          {formatCurrency(total)}).
        </div>
        {hasPending && (
          <div>
            Si los {others.filter((p) => p.status === "pending").length}{" "}
            pendientes aceptan, bajará a{" "}
            <strong className="text-foreground">
              {formatCurrency(bestCase)}
            </strong>
            ; si rechazan, vos absorbés y queda en {formatCurrency(currentEffective)}.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ParticipantStatus({ status }: { status: string }) {
  if (status === "owner") {
    return (
      <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
        Owner
      </span>
    );
  }
  if (status === "accepted") {
    return (
      <span className="rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
        Aceptado
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive">
        Rechazado
      </span>
    );
  }
  return (
    <span className="rounded-full bg-brand/15 px-2.5 py-1 text-[11px] font-medium text-brand">
      Pendiente
    </span>
  );
}
