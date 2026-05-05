"use client";

import { useMemo, useState } from "react";
import { Check, ClipboardList, Inbox, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  useCategories,
  usePendingApprovalsAsOwner,
} from "@/hooks/use-data";
import { apiFetch } from "@/lib/api";
import type { PendingApproval } from "@/lib/domain/types";
import { formatCurrency, formatDate } from "@/lib/format";

export default function AprobacionesPage() {
  const { data: approvals, loading } = usePendingApprovalsAsOwner();
  const { data: categories } = useCategories();
  const [approving, setApproving] = useState<PendingApproval | null>(null);
  const [rejecting, setRejecting] = useState<PendingApproval | null>(null);

  const expenseCategories = useMemo(
    () => categories.filter((c) => c.kind === "expense"),
    [categories],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Aprobaciones</h1>
        <p className="text-sm text-muted-foreground">
          Gastos cargados desde tus cuentas compartidas, esperando tu aprobación
        </p>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!loading && approvals.length === 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-16 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
              <Inbox className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Nada para aprobar</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Cuando alguien cargue un gasto en una cuenta tuya, te aparece acá.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {approvals.map((a) => (
          <Card key={a.id} className="rounded-2xl">
            <CardContent className="space-y-3 py-3.5">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                  <ClipboardList className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {a.description || "Gasto"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {a.granteeDisplayName || a.granteeEmail} · {a.accountName} ·{" "}
                    {formatDate(a.purchaseDate.toDate())}
                    {a.installments > 1 ? ` · ${a.installments} cuotas` : ""}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums">
                  {formatCurrency(a.totalAmount)}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 bg-brand-grad text-white hover:opacity-95"
                  onClick={() => setApproving(a)}
                >
                  <Check className="mr-1 size-4" /> Aprobar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setRejecting(a)}
                >
                  <X className="mr-1 size-4" /> Rechazar
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Approve sheet */}
      <Sheet open={!!approving} onOpenChange={(v) => !v && setApproving(null)}>
        <SheetContent side="bottom" className="sheet-md-modal p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Aprobar gasto</SheetTitle>
          </SheetHeader>
          {approving && (
            <ApproveBody
              approval={approving}
              categories={expenseCategories}
              onDone={() => setApproving(null)}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Reject sheet */}
      <Sheet open={!!rejecting} onOpenChange={(v) => !v && setRejecting(null)}>
        <SheetContent side="bottom" className="sheet-md-modal p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Rechazar gasto</SheetTitle>
          </SheetHeader>
          {rejecting && (
            <RejectBody
              approval={rejecting}
              onDone={() => setRejecting(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ApproveBody({
  approval,
  categories,
  onDone,
}: {
  approval: PendingApproval;
  categories: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!categoryId) {
      toast.error("Elegí una categoría");
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch("/api/account-shares/respond", {
        method: "POST",
        body: JSON.stringify({
          approvalId: approval.id,
          decision: "approved",
          categoryId,
        }),
      });
      if (!r.ok) {
        const data = (await r.json()) as { error?: string };
        toast.error(data.error ?? "No se pudo aprobar");
        return;
      }
      toast.success("Gasto aprobado e impactado en tu cuenta");
      onDone();
    } catch (err) {
      toast.error("No se pudo aprobar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 px-5 pb-6 pt-3">
      <Card className="rounded-xl bg-muted/40">
        <CardContent className="py-3 text-sm">
          <div className="font-semibold">{approval.description || "Gasto"}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {approval.granteeDisplayName || approval.granteeEmail} ·{" "}
            {approval.accountName} ·{" "}
            {formatDate(approval.purchaseDate.toDate())}
            {approval.installments > 1
              ? ` · ${approval.installments} cuotas`
              : ""}
          </div>
          <div className="mt-2 text-lg font-semibold tabular-nums">
            {formatCurrency(approval.totalAmount)}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-1.5">
        <Label>Categoría</Label>
        {categories.length === 0 ? (
          <a
            href="/categorias"
            className="block rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground hover:bg-muted/40"
          >
            No tenés categorías de gasto.{" "}
            <span className="font-medium underline">Crear una</span>
          </a>
        ) : (
          <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? "")}>
            <SelectTrigger className="h-12 w-full">
              <SelectValue
                placeholder="Elegí una categoría"
                items={categories.map((c) => ({ value: c.id, label: c.name }))}
              />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-xs text-muted-foreground">
          La categoría que elijas se aplica al gasto en tus movimientos.
        </p>
      </div>

      <Button
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        onClick={submit}
        disabled={busy || !categoryId}
      >
        {busy ? "Aprobando…" : "Aprobar e impactar"}
      </Button>
    </div>
  );
}

function RejectBody({
  approval,
  onDone,
}: {
  approval: PendingApproval;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/account-shares/respond", {
        method: "POST",
        body: JSON.stringify({
          approvalId: approval.id,
          decision: "rejected",
          rejectReason: reason.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const data = (await r.json()) as { error?: string };
        toast.error(data.error ?? "No se pudo rechazar");
        return;
      }
      toast.success("Gasto rechazado");
      onDone();
    } catch (err) {
      toast.error("No se pudo rechazar");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 px-5 pb-6 pt-3">
      <Card className="rounded-xl bg-muted/40">
        <CardContent className="py-3 text-sm">
          <div className="font-semibold">{approval.description || "Gasto"}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {approval.granteeDisplayName || approval.granteeEmail} ·{" "}
            {formatCurrency(approval.totalAmount)}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-1.5">
        <Label htmlFor="reject-reason">Motivo (opcional)</Label>
        <Input
          id="reject-reason"
          className="h-12"
          placeholder="Le aviso a quien lo cargó"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      <Button
        className="w-full h-12"
        variant="outline"
        onClick={submit}
        disabled={busy}
      >
        {busy ? "Rechazando…" : "Rechazar"}
      </Button>
    </div>
  );
}
