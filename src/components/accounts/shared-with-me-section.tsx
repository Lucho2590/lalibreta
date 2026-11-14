"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Eye, Handshake, Loader2, Plus, ShieldCheck } from "lucide-react";
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
import type { AccountShare, PendingApproval } from "@/lib/domain/types";
import { formatCurrency, formatDate, formatMoney } from "@/lib/format";
import type { SharedMovementsResponse } from "@/lib/domain/shared-movements";

/** Cuentas que otra persona compartió conmigo, agrupadas por esa persona. */
export interface SharedGroup {
  /** Id para ordenar junto con las cuentas propias: "shared:{ownerUid}". */
  id: string;
  ownerUid: string;
  ownerName: string;
  firstName: string;
  shares: AccountShare[];
  /** Todo lo que cargo ahí entra directo (compartidas por WhatsApp). */
  direct: boolean;
}

export const sharedGroupId = (ownerUid: string) => `shared:${ownerUid}`;
export const isSharedGroupId = (id: string) => id.startsWith("shared:");

export function useSharedWithMe() {
  const { data: shares, loading } = useAccountSharesAsGrantee();
  const { data: approvals } = useApprovalsAsGrantee();

  const pendingByShare = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of approvals) {
      if (a.status !== "pending") continue;
      m.set(a.shareId, (m.get(a.shareId) ?? 0) + 1);
    }
    return m;
  }, [approvals]);

  const groups = useMemo<SharedGroup[]>(() => {
    const byOwner = new Map<string, AccountShare[]>();
    for (const s of shares) {
      const arr = byOwner.get(s.ownerUid) ?? [];
      arr.push(s);
      byOwner.set(s.ownerUid, arr);
    }
    return [...byOwner.entries()].map(([ownerUid, list]) => {
      const ownerName = list[0].ownerDisplayName || list[0].ownerEmail.split("@")[0];
      return {
        id: sharedGroupId(ownerUid),
        ownerUid,
        ownerName,
        firstName: ownerName.split(" ")[0],
        shares: [...list].sort((a, b) => a.accountName.localeCompare(b.accountName, "es")),
        direct: list.every((s) => s.mode === "direct"),
      };
    });
  }, [shares]);

  return { groups, approvals, pendingByShare, loading };
}

/**
 * Tarjeta "Compartidas con {nombre}": se pliega como una cuenta madre y
 * adentro lista sus cuentas con el botón para cargar.
 */
export function SharedGroupCard({
  group,
  pendingByShare,
  handle,
  overlay,
  collapsed,
  onToggle,
  onLoad,
  onView,
}: {
  group: SharedGroup;
  pendingByShare: Map<string, number>;
  handle?: React.ReactNode;
  overlay?: boolean;
  collapsed: boolean;
  onToggle?: () => void;
  onLoad?: (share: AccountShare) => void;
  onView?: (share: AccountShare) => void;
}) {
  const n = group.shares.length;
  const pending = group.shares.reduce((acc, s) => acc + (pendingByShare.get(s.id) ?? 0), 0);
  return (
    <div className="space-y-2">
      <div className="relative">
        <div className="absolute left-1 top-1/2 z-10 -translate-y-1/2">{handle}</div>
        <button
          type="button"
          onClick={onToggle}
          disabled={overlay}
          aria-expanded={!collapsed}
          className="block w-full text-left"
        >
          <Card className="rounded-2xl transition hover:shadow-md active:scale-[0.99]">
            <CardContent className="flex items-center gap-3 py-4 pl-8 pr-14">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand/15 text-lg font-bold text-brand">
                {group.firstName[0]?.toUpperCase() ?? "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">Compartidas con {group.firstName}</span>
                  <Handshake className="size-4 shrink-0 text-brand" />
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {n} {n === 1 ? "cuenta" : "cuentas"} de {group.ownerName}
                  {group.direct ? " · lo que cargás entra directo" : " · lo que cargás queda para aprobar"}
                  {pending > 0 ? ` · ${pending} ${pending === 1 ? "pendiente" : "pendientes"}` : ""}
                </div>
              </div>
            </CardContent>
          </Card>
        </button>
        {!overlay && (
          <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
            <span className="flex size-9 items-center justify-center text-muted-foreground">
              <ChevronDown
                className={`size-4 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
              />
            </span>
          </div>
        )}
      </div>

      {!collapsed && !overlay && (
        <div className="ml-5 space-y-2 border-l-2 border-border pl-3">
          {group.shares.map((s) => {
            const p = pendingByShare.get(s.id) ?? 0;
            return (
              <Card
                key={s.id}
                className="cursor-pointer rounded-xl transition hover:shadow-sm"
                onClick={() => onView?.(s)}
              >
                <CardContent className="flex items-center gap-3 py-3 pl-4 pr-3">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground">
                    <AccountIcon name={s.accountIcon ?? defaultIconForType(s.accountType)} className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.accountName}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {TYPE_LABEL[s.accountType] ?? "Cuenta"}
                      {s.visibility === "all" ? " · ves todos los gastos" : " · ves lo que cargás vos"}
                      {p > 0 ? ` · ${p} ${p === 1 ? "pendiente" : "pendientes"}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="hidden text-muted-foreground sm:inline-flex"
                    onClick={(e) => {
                      e.stopPropagation();
                      onView?.(s);
                    }}
                  >
                    <Eye className="mr-1 size-4" /> Ver
                  </Button>
                  <Button
                    size="sm"
                    className="bg-brand-grad text-white hover:opacity-95"
                    onClick={(e) => {
                      e.stopPropagation();
                      onLoad?.(s);
                    }}
                  >
                    <Plus className="mr-1 size-4" /> Cargar
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<AccountShare["accountType"], string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Tarjeta de crédito",
  checking: "Cuenta corriente",
  savings: "Caja de ahorro",
  digital: "Billetera virtual",
  reserve: "Cobacha",
};

/** Hoja para cargar un gasto en una cuenta compartida. */
export function SharedSubmitSheet({ share, onClose }: { share: AccountShare | null; onClose: () => void }) {
  return (
    <Sheet open={!!share} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="bottom" className="sheet-md-modal p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>Cargar en {share?.accountName ?? "cuenta compartida"}</SheetTitle>
        </SheetHeader>
        {share && <SubmitForm share={share} onDone={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

const shiftMonth = (key: string, delta: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthTitle = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  const t = new Date(y, m - 1, 1).toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  return t[0].toUpperCase() + t.slice(1);
};
const moneyLine = (m: Record<"ARS" | "USD", number>) => {
  const parts = (["ARS", "USD"] as const).filter((c) => Math.abs(m[c]) >= 0.01).map((c) => formatMoney(m[c], c));
  return parts.length ? parts.join(" + ") : formatMoney(0, "ARS");
};

/**
 * Movimientos de una cuenta compartida conmigo. Lo que se ve lo decide el
 * dueño: solo lo que cargué yo, o todos los gastos de la cuenta.
 */
export function SharedMovementsSheet({ share, onClose }: { share: AccountShare | null; onClose: () => void }) {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [data, setData] = useState<SharedMovementsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!share) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga desde la API al abrir o cambiar de mes
    setLoading(true);
    apiFetch(`/api/account-shares/movements?shareId=${encodeURIComponent(share.id)}&month=${month}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        if (!cancelled) setData(body as SharedMovementsResponse);
      })
      .catch((err) => {
        if (!cancelled) toast.error(err instanceof Error && err.message ? err.message : "No se pudieron cargar los movimientos");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [share, month]);

  const view = data && share && data.shareId === share.id && data.month === month ? data : null;

  return (
    <Sheet
      open={!!share}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
          setData(null);
        }
      }}
    >
      <SheetContent side="bottom" className="sheet-md-modal p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>{share?.accountName}</SheetTitle>
          <p className="text-xs text-muted-foreground">
            De {share?.ownerDisplayName || share?.ownerEmail} ·{" "}
            {share?.visibility === "all" ? "te deja ver todos los gastos" : "ves solo lo que cargaste vos"}
          </p>
        </SheetHeader>
        <div className="space-y-4 px-5 pb-6 pt-2">
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Mes anterior">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm font-semibold">{monthTitle(month)}</span>
            <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Mes siguiente">
              <ChevronRight className="size-4" />
            </Button>
          </div>

          {!view || loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className={`grid gap-2 ${view.accountTotal ? "grid-cols-2" : "grid-cols-1"}`}>
                <div className="rounded-2xl bg-muted/50 p-3">
                  <div className="text-[11px] text-muted-foreground">Lo que cargaste vos</div>
                  <div className="font-semibold tabular-nums">{moneyLine(view.mineTotal)}</div>
                </div>
                {view.accountTotal && (
                  <div className="rounded-2xl bg-muted/50 p-3">
                    <div className="text-[11px] text-muted-foreground">
                      Total de la cuenta
                      {view.dueDate ? ` · vence ${formatDate(new Date(view.dueDate))}` : ""}
                    </div>
                    <div className="font-semibold tabular-nums">{moneyLine(view.accountTotal)}</div>
                  </div>
                )}
              </div>

              {view.items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {view.visibility === "own"
                    ? "No cargaste nada en esta cuenta para este mes."
                    : "No hay gastos en esta cuenta para este mes."}
                </p>
              ) : (
                <ul className="divide-y rounded-2xl border">
                  {view.items.map((i) => {
                    const negative = i.credit || i.kind === "income";
                    return (
                      <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{i.description}</span>
                            {i.mine && view.visibility === "all" && (
                              <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                                Vos
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {formatDate(new Date(i.date))}
                            {i.categoryName ? ` · ${i.categoryName}` : ""}
                            {i.installment ? ` · cuota ${i.installment}` : ""}
                            {i.createdByName ? ` · cargó ${i.createdByName}` : ""}
                          </div>
                        </div>
                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${negative ? "text-success" : ""}`}>
                          {negative ? "−" : ""}
                          {formatMoney(i.amount, i.currency)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Lo que cargué en cuentas de otros (con su estado). */
export function SharedApprovals({ approvals }: { approvals: PendingApproval[] }) {
  if (approvals.length === 0) return null;
  return (
    <details className="rounded-xl border bg-muted/30 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        Tus envíos a cuentas compartidas ({approvals.length})
      </summary>
      <div className="mt-2 space-y-1.5">
        {approvals.slice(0, 10).map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
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
        share.mode === "direct"
          ? `Cargado en la cuenta de ${share.ownerDisplayName || share.ownerEmail}`
          : `Enviado a ${share.ownerDisplayName || share.ownerEmail} para aprobación`,
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
        {share.mode === "direct"
          ? "El gasto entra directo a su cuenta y le avisamos."
          : "El gasto queda pendiente de aprobación. La categoría la elige el dueño al aprobar."}
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
            <ShieldCheck className="mr-1 size-4" />{" "}
            {share.mode === "direct" ? "Cargar gasto" : "Enviar para aprobación"}
          </>
        )}
      </Button>
    </form>
  );
}
