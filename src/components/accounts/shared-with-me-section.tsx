"use client";

import { useMemo, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AccountIcon, defaultIconForType } from "@/components/account-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  useAccountSharesAsGrantee,
  useApprovalsAsGrantee,
} from "@/hooks/use-data";
import { apiFetch } from "@/lib/api";
import type { AccountShare } from "@/lib/domain/types";
import { formatCurrency, formatDate } from "@/lib/format";

export function SharedWithMeSection() {
  const { data: shares, loading } = useAccountSharesAsGrantee();
  const { data: approvals } = useApprovalsAsGrantee();
  const [submitting, setSubmitting] = useState<AccountShare | null>(null);

  const pendingByShare = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of approvals) {
      if (a.status !== "pending") continue;
      m.set(a.shareId, (m.get(a.shareId) ?? 0) + 1);
    }
    return m;
  }, [approvals]);

  if (loading || shares.length === 0) return null;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground">
          Cuentas compartidas conmigo
        </h2>
        <p className="text-xs text-muted-foreground">
          Otros usuarios te dieron acceso. Lo que cargues queda pendiente de aprobación.
        </p>
      </div>
      <div className="space-y-2">
        {shares.map((s) => {
          const pending = pendingByShare.get(s.id) ?? 0;
          return (
            <Card key={s.id} className="rounded-2xl">
              <CardContent className="flex items-center gap-3 py-4">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-muted text-foreground">
                  <AccountIcon
                    name={s.accountIcon ?? defaultIconForType(s.accountType)}
                    className="size-5"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{s.accountName}</span>
                    <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand">
                      Compartida
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    de {s.ownerDisplayName || s.ownerEmail}
                    {pending > 0
                      ? ` · ${pending} ${pending === 1 ? "pendiente" : "pendientes"}`
                      : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  className="bg-brand-grad text-white hover:opacity-95"
                  onClick={() => setSubmitting(s)}
                >
                  <Plus className="mr-1 size-4" /> Cargar
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Sheet open={!!submitting} onOpenChange={(v) => !v && setSubmitting(null)}>
        <SheetContent side="bottom" className="sheet-md-modal p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Cargar en cuenta compartida</SheetTitle>
          </SheetHeader>
          {submitting && (
            <SubmitForm share={submitting} onDone={() => setSubmitting(null)} />
          )}
        </SheetContent>
      </Sheet>

      {/* Aprobaciones que cargaste y están pendientes */}
      {approvals.length > 0 && (
        <details className="rounded-xl border bg-muted/30 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Tus envíos a estas cuentas ({approvals.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {approvals.slice(0, 10).map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{a.description || "Gasto"}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {a.accountName} · {formatDate(a.purchaseDate.toDate())}
                  </span>
                </div>
                <span className="tabular-nums">{formatCurrency(a.totalAmount)}</span>
                <ApprovalStatusChip status={a.status} />
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ApprovalStatusChip({ status }: { status: string }) {
  if (status === "approved") {
    return (
      <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
        Aprobado
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
        Rechazado
      </span>
    );
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      Pendiente
    </span>
  );
}

function SubmitForm({
  share,
  onDone,
}: {
  share: AccountShare;
  onDone: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(today);
  const [installments, setInstallments] = useState(1);
  const [cardClosed, setCardClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const isCredit = share.accountType === "credit";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Monto inválido");
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch("/api/account-shares/submit", {
        method: "POST",
        body: JSON.stringify({
          shareId: share.id,
          description,
          totalAmount: n,
          purchaseDate: date,
          installments,
          cardClosedAtPurchase: isCredit ? cardClosed : false,
        }),
      });
      if (!r.ok) {
        const data = (await r.json()) as { error?: string };
        toast.error(data.error ?? "No se pudo enviar");
        return;
      }
      toast.success(
        `Enviado a ${share.ownerDisplayName || share.ownerEmail} para aprobación`,
      );
      onDone();
    } catch (err) {
      toast.error("No se pudo enviar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 px-5 pb-6 pt-3">
      <div className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
        Cuenta: <span className="font-medium text-foreground">{share.accountName}</span>{" "}
        · de {share.ownerDisplayName || share.ownerEmail}
        <br />
        El gasto queda pendiente de aprobación. La categoría la elige el dueño al aprobar.
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ext-amount">Monto</Label>
        <Input
          id="ext-amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          className="h-12 text-lg"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ext-desc">Descripción</Label>
        <Input
          id="ext-desc"
          className="h-12"
          placeholder="Ej: Super Coto"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ext-date">Fecha</Label>
        <Input
          id="ext-date"
          type="date"
          className="h-12"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      {isCredit && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="ext-installments">Cuotas</Label>
            <Input
              id="ext-installments"
              type="number"
              inputMode="numeric"
              min={1}
              max={36}
              className="h-11"
              value={installments}
              onChange={(e) => setInstallments(Number(e.target.value) || 1)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="ext-card-closed" className="text-sm">
                ¿La tarjeta ya estaba cerrada?
              </Label>
              <p className="text-xs text-muted-foreground">
                Si activás esto, la primera cuota cae en el mes siguiente.
              </p>
            </div>
            <Switch
              id="ext-card-closed"
              checked={cardClosed}
              onCheckedChange={setCardClosed}
            />
          </div>
        </div>
      )}

      <Button
        type="submit"
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        disabled={busy || !amount}
      >
        {busy ? "Enviando…" : (
          <>
            <ShieldCheck className="mr-1 size-4" /> Enviar para aprobación
          </>
        )}
      </Button>
    </form>
  );
}
