"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { ArrowLeft, Check, Clock, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CategorySelect } from "@/components/category-select";
import { SplitSection, splitPayload, type SplitState } from "@/components/transactions/split-section";
import { useAuth } from "@/hooks/use-auth";
import { useCategories, useSplitRules } from "@/hooks/use-data";
import { normalizeMerchant } from "@/lib/domain/merchants";
import { db } from "@/lib/firebase/client";
import { apiPost, errorText } from "@/lib/api";
import { participantSchedule, type Split, type SplitParticipant } from "@/lib/domain/people";
import { formatMoney, formatMonth } from "@/lib/format";

const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return formatMonth(y, m);
};
const ddmm = (ymd: string) => ymd.split("-").reverse().join("/");
const num = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);

const STATUS: Record<SplitParticipant["status"], { label: string; cls: string }> = {
  pending: { label: "Sin responder", cls: "bg-muted text-muted-foreground" },
  accepted: { label: "Aceptó", cls: "bg-success/10 text-success" },
  rejected: { label: "No aceptó", cls: "bg-destructive/10 text-destructive" },
  offline: { label: "Sin app · te lo debe", cls: "bg-brand/10 text-brand" },
};

export default function SplitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { user } = useAuth();
  const { data: categories } = useCategories();
  const { data: rules } = useSplitRules();
  const [split, setSplit] = useState<Split | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addToBooks, setAddToBooks] = useState(true);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [acceptAlways, setAcceptAlways] = useState(true);
  const [editing, setEditing] = useState<SplitState | null>(null);

  useEffect(() => {
    return onSnapshot(
      doc(db, "splits", id),
      (snap) => {
        if (!snap.exists()) return setMissing(true);
        setSplit({ id: snap.id, ...(snap.data() as Omit<Split, "id">) });
      },
      () => setMissing(true),
    );
  }, [id]);

  const expenseCats = categories.filter((c) => c.kind === "expense");

  if (missing) {
    return (
      <div className="space-y-3">
        <Link href="/compartidas" className="inline-flex items-center text-sm text-muted-foreground">
          <ArrowLeft className="mr-1 size-4" /> Cuentas con gente
        </Link>
        <p className="text-sm">Este gasto ya no existe o no participás.</p>
      </div>
    );
  }
  if (!split || !user) return <p className="text-sm text-muted-foreground">Cargando…</p>;

  const isOwner = split.ownerUid === user.uid;
  const me = split.participants.find((p) => p.uid === user.uid);
  const cancelled = split.status === "cancelled";
  const others = split.participants.reduce((s, p) => s + p.amount, 0);
  const ownerShare = Math.round((split.totalAmount - others) * 100) / 100;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const respond = (accept: boolean) =>
    run(
      () =>
        apiPost("/api/splits/respond", {
          splitId: split.id,
          accept,
          addToBooks: accept && addToBooks,
          categoryId: accept && addToBooks ? categoryId : null,
          reason: accept ? null : reason,
          always: accept && !!split.ruleId && acceptAlways,
        }),
      accept ? (addToBooks ? "Aceptado y sumado a tus gastos" : "Aceptado") : "Le avisamos que no lo aceptaste",
    );

  const setBooks = (add: boolean) =>
    run(
      () => apiPost("/api/splits/books", { splitId: split.id, addToBooks: add, categoryId: add ? categoryId : null }),
      add ? "Sumado a tus gastos" : "Lo sacaste de tus gastos (lo que debés no cambia)",
    );

  const startEdit = () =>
    setEditing({
      enabled: true,
      mode: split.mode,
      people: split.participants.map((p) => ({
        ref: p.ref,
        name: p.name,
        isApp: !!p.uid,
        shareType: p.shareType,
        input: num(p.shareType === "percent" && p.percent != null ? p.percent : p.amount),
      })),
    });

  const saveEdit = async () => {
    if (!editing) return;
    const payload = splitPayload(split.totalAmount, editing);
    if (payload.error) return toast.error(payload.error);
    const ok = await run(
      () => apiPost("/api/splits/update", { splitId: split.id, mode: editing.mode, participants: payload.participants }),
      "Reparto actualizado",
    );
    if (ok) setEditing(null);
  };

  const cancel = async (deleteOwnerTx: boolean) => {
    const msg = deleteOwnerTx
      ? "¿Borrar el gasto y cancelar el reparto? Se les avisa a todos."
      : "¿Cancelar el reparto? El gasto queda entero para vos y se les avisa.";
    if (!confirm(msg)) return;
    const ok = await run(() => apiPost("/api/splits/cancel", { splitId: split.id, deleteOwnerTx }), "Reparto cancelado");
    if (ok && deleteOwnerTx) router.push("/compartidas");
  };

  const mySchedule = me ? participantSchedule(split, me.amount) : [];
  const rule = isOwner ? rules.find((r) => r.key === normalizeMerchant(split.description)) : undefined;

  const makeRule = () =>
    run(
      () =>
        apiPost("/api/splits/rules", {
          txId: split.ownerTxId,
          mode: split.mode,
          participants: split.participants.map((p) => ({
            ref: p.ref,
            shareType: p.shareType,
            value: p.shareType === "percent" && p.percent != null ? p.percent : p.amount,
          })),
        }),
      `Listo: los gastos de «${split.description}» se van a dividir siempre así`,
    );
  const removeRule = () =>
    rule && run(() => apiPost("/api/splits/rules/delete", { id: rule.id }), "Ya no se divide solo (lo ya dividido queda)");

  return (
    <div className="space-y-6">
      <Link href="/compartidas" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 size-4" /> Cuentas con gente
      </Link>

      <div className="overflow-hidden rounded-3xl bg-brand-grad p-6 text-white shadow-lg">
        <div className="text-[11px] font-medium uppercase tracking-wider opacity-80">
          {isOwner ? "Gasto que dividiste" : `Gasto de ${split.ownerName}`}
          {cancelled && " · cancelado"}
        </div>
        <div className="mt-1 text-2xl font-bold">{split.description}</div>
        <div className="mt-2 text-3xl font-bold tabular-nums">{formatMoney(split.totalAmount, split.currency)}</div>
        <div className="mt-1 text-sm opacity-90">
          {ddmm(split.date)}
          {split.ownerAccountName && isOwner && ` · ${split.ownerAccountName}`}
          {split.installments > 1 && ` · ${split.installments} cuotas`}
          {split.schedule.length > 1 && ` · ${split.mode === "lump" ? "se paga todo junto" : "se paga en cuotas"}`}
        </div>
      </div>

      {/* Mi parte (participante) */}
      {me && !cancelled && (
        <Card className={`rounded-3xl ${me.status === "pending" ? "ring-2 ring-brand/30" : ""}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              Tu parte: {formatMoney(me.amount, split.currency)}
              {me.percent != null && <span className="text-muted-foreground"> ({num(me.percent)}%)</span>}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {mySchedule.length > 1
                ? `Se la pagás a ${split.ownerName} en ${mySchedule.length} cuotas: ${mySchedule.map((c) => `${monthLabel(c.paymentMonth)} ${formatMoney(c.amount, split.currency)}`).join(" · ")}`
                : `Se la pagás a ${split.ownerName}${mySchedule[0] ? ` (${monthLabel(mySchedule[0].paymentMonth)})` : ""}.`}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {me.status === "pending" && (
              <>
                <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
                  <div>
                    <Label htmlFor="books" className="text-sm">Sumarlo a mis gastos</Label>
                    <p className="text-xs text-muted-foreground">
                      Cuenta en tu balance del mes. No mueve tus cuentas: queda como plata que le debés.
                    </p>
                  </div>
                  <Switch id="books" checked={addToBooks} onCheckedChange={setAddToBooks} />
                </div>
                {addToBooks && (
                  <CategorySelect
                    value={categoryId}
                    onChange={setCategoryId}
                    groups={[{ categories: expenseCats }]}
                    placeholder="¿En qué categoría?"
                  />
                )}
                {split.ruleId && (
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-brand"
                      checked={acceptAlways}
                      onChange={(e) => setAcceptAlways(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium">Aceptar siempre</span>
                      <span className="block text-xs text-muted-foreground">
                        {split.ownerName.split(" ")[0]} lo divide todos los meses: los próximos de «{split.description}» se te suman solos
                        {addToBooks ? " (con esta categoría)" : ""}.
                      </span>
                    </span>
                  </label>
                )}
                {rejecting ? (
                  <div className="space-y-2">
                    <Input placeholder="¿Por qué? (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} />
                    <div className="flex gap-2">
                      <Button variant="destructive" disabled={busy} onClick={() => respond(false)}>
                        No lo acepto
                      </Button>
                      <Button variant="ghost" onClick={() => setRejecting(false)}>
                        Volver
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      className="flex-1 bg-brand-grad text-white hover:opacity-95"
                      disabled={busy || (addToBooks && !categoryId)}
                      onClick={() => respond(true)}
                    >
                      <Check className="mr-1 size-4" /> Aceptar
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
                      <X className="mr-1 size-4" /> No
                    </Button>
                  </div>
                )}
              </>
            )}
            {me.status === "accepted" && (
              <div className="space-y-2">
                <p className="text-sm text-success">✓ Aceptaste tu parte.</p>
                {split.ruleId && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
                    <div>
                      <Label htmlFor="always" className="text-sm">Aceptar siempre</Label>
                      <p className="text-xs text-muted-foreground">
                        Los próximos de «{split.description}» se te suman solos, sin que tengas que aceptarlos.
                      </p>
                    </div>
                    <Switch
                      id="always"
                      checked={!!me.autoAccept}
                      disabled={busy}
                      onCheckedChange={(v) =>
                        run(
                          () => apiPost("/api/splits/auto-accept", { splitId: split.id, enabled: v }),
                          v ? "Listo: los próximos se aceptan solos" : "Los próximos vas a tener que aceptarlos",
                        )
                      }
                    />
                  </div>
                )}
                {me.addToBooks ? (
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      Está en tus gastos ({categories.find((c) => c.id === me.categoryId)?.name ?? "sin categoría"}).
                    </span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBooks(false)}>
                      Sacar de mis gastos
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">No está en tus gastos. ¿Lo sumás?</p>
                    <CategorySelect
                      value={categoryId}
                      onChange={setCategoryId}
                      groups={[{ categories: expenseCats }]}
                      placeholder="¿En qué categoría?"
                    />
                    <Button size="sm" disabled={busy || !categoryId} onClick={() => setBooks(true)}>
                      Sumar a mis gastos
                    </Button>
                  </div>
                )}
              </div>
            )}
            {me.status === "rejected" && (
              <p className="text-sm text-muted-foreground">
                No lo aceptaste{me.rejectReason ? `: "${me.rejectReason}"` : ""}. Si {split.ownerName} lo cambia, te llega de nuevo.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reparto */}
      <Card className="rounded-3xl">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-semibold">Reparto</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <div className="flex items-center justify-between py-2.5 text-sm">
            <span>
              {isOwner ? "Vos" : split.ownerName} <span className="text-muted-foreground">(pagó)</span>
            </span>
            <span className="font-semibold tabular-nums">{formatMoney(ownerShare, split.currency)}</span>
          </div>
          {split.participants.map((p) => (
            <div key={p.ref} className="flex items-center justify-between gap-2 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="truncate">{p.uid === user.uid ? "Vos" : p.name}</div>
                {p.status === "rejected" && p.rejectReason && (
                  <div className="truncate text-xs text-muted-foreground">&quot;{p.rejectReason}&quot;</div>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS[p.status].cls}`}>
                {p.status === "pending" && <Clock className="mr-0.5 inline size-3" />}
                {STATUS[p.status].label}
                {p.autoAccept && p.status === "accepted" && " · siempre"}
              </span>
              <span className="w-28 shrink-0 text-right font-semibold tabular-nums">{formatMoney(p.amount, split.currency)}</span>
            </div>
          ))}
          {isOwner && !cancelled && (
            <p className="pt-2.5 text-xs text-muted-foreground">
              Para vos cuenta tu parte más lo que todavía no aceptaron. Lo de la gente sin la app baja recién cuando te lo pagan.
            </p>
          )}
        </CardContent>
      </Card>

      {isOwner && !cancelled && (
        <Card className="rounded-3xl">
          <CardContent className="space-y-3 py-4">
            {editing ? (
              <>
                <SplitSection
                  totalAmount={split.totalAmount}
                  currency={split.currency}
                  installments={split.schedule.length}
                  value={editing}
                  onChange={setEditing}
                />
                <p className="text-xs text-muted-foreground">
                  Lo que ya aceptaron no se puede cambiar. A los que les cambia la parte les llega de nuevo.
                </p>
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={saveEdit}>
                    Guardar cambios
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(null)}>
                    Cancelar
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap gap-2">
                {rule ? (
                  <Button variant="ghost" disabled={busy} onClick={removeRule} title="Se divide solo cada vez que entra este gasto">
                    ✓ Se divide siempre · quitar
                  </Button>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={makeRule} title="Los próximos (y los estimados) se dividen solos">
                    Dividir siempre así
                  </Button>
                )}
                <Button variant="outline" onClick={startEdit}>
                  Cambiar reparto
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => cancel(false)}>
                  Cancelar reparto
                </Button>
                <Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => cancel(true)}>
                  Borrar gasto
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
