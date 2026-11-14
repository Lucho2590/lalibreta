"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  BrainCircuit,
  Eraser,
  Loader2,
  LogOut,
  MessageCircle,
  MoreVertical,
  RefreshCw,
  Shuffle,
  Smartphone,
  Unlink,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PinDialog } from "@/components/admin/admin-logo-tap";
import { adminFetch, clearAdminToken, getAdminToken } from "@/lib/admin-client";
import { AI_FEATURE_LABEL, type AiFeature, type AiUsageBucket } from "@/lib/domain/ai-pricing";
import type { AdminAction, AdminOverview, AdminUserRow } from "@/lib/domain/admin";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Formato

const usd = (n: number) => {
  const digits = n === 0 ? 2 : n < 0.01 ? 4 : n < 1 ? 3 : 2;
  return `US$ ${n.toLocaleString("es-AR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const ars = (n: number) => `$ ${Math.round(n).toLocaleString("es-AR")}`;
const compact = (n: number) =>
  n.toLocaleString("es-AR", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("es-AR", { month: "short", year: "2-digit" }).replace(".", "");
};
const rtf = new Intl.RelativeTimeFormat("es-AR", { numeric: "auto" });
const ago = (isoDate: string | null) => {
  if (!isoDate) return "—";
  const secs = (new Date(isoDate).getTime() - Date.now()) / 1000;
  const abs = Math.abs(secs);
  if (abs < 60) return "recién";
  if (abs < 3600) return rtf.format(Math.round(secs / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(secs / 86400), "day");
  return new Date(isoDate).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "2-digit" });
};
const phone = (waId: string) =>
  waId.startsWith("549") && waId.length >= 12
    ? `+54 9 ${waId.slice(3, waId.length - 7)} ${waId.slice(-7, -4)}-${waId.slice(-4)}`
    : `+${waId}`;

// ---------------------------------------------------------------------------

export default function AdminPage() {
  const router = useRouter();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [needPin, setNeedPin] = useState(false);

  const load = useCallback(async () => {
    if (!getAdminToken()) {
      setNeedPin(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await adminFetch("/api/admin/overview");
      if (res.status === 403 || res.status === 401) {
        clearAdminToken();
        setNeedPin(true);
        return;
      }
      if (!res.ok) throw new Error();
      setData((await res.json()) as AdminOverview);
    } catch {
      toast.error("No se pudo cargar el panel");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial desde la API
    void load();
  }, [load]);

  if (needPin) {
    return (
      <>
        <Card className="mx-auto mt-10 max-w-sm rounded-3xl">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Panel de administración bloqueado.
          </CardContent>
        </Card>
        <PinDialog
          open
          onOpenChange={(v) => {
            if (!v) router.replace("/");
          }}
          onUnlocked={() => {
            setNeedPin(false);
            void load();
          }}
        />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Administración</h1>
          <p className="text-sm text-muted-foreground">
            Usuarios, agentes y consumo de IA.{" "}
            {data && <span>Actualizado {ago(data.generatedAt)}.</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="rounded-xl" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("mr-1.5 size-4", loading && "animate-spin")} /> Actualizar
          </Button>
          <Button
            variant="ghost"
            className="rounded-xl text-muted-foreground"
            onClick={() => {
              clearAdminToken();
              router.replace("/");
            }}
          >
            <LogOut className="mr-1.5 size-4" /> Salir
          </Button>
        </div>
      </div>

      {!data ? (
        <div className="flex justify-center py-20">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <KpiRow data={data} />
          <div className="grid gap-4 lg:grid-cols-3">
            <TrendCard data={data} />
            <BreakdownCard
              title="Este mes, por función"
              rows={Object.entries(data.thisMonthByFeature).map(([k, b]) => ({
                label: AI_FEATURE_LABEL[k as AiFeature] ?? k,
                bucket: b!,
              }))}
            />
            <BreakdownCard
              title="Este mes, por modelo"
              rows={Object.entries(data.thisMonthByModel).map(([k, b]) => ({ label: k, bucket: b }))}
            />
          </div>
          <UsersList data={data} onChanged={() => void load()} />
          <p className="text-xs text-muted-foreground">
            Costos estimados con los precios de lista de OpenAI al momento de cada llamada. El consumo se
            registra desde que se instaló este panel; lo anterior no figura. En pesos: dólar oficial BCRA
            {data.usdRate ? ` (${ars(data.usdRate)})` : ""}, sin impuestos de la tarjeta.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function KpiRow({ data }: { data: AdminOverview }) {
  const { thisMonth, lastMonth } = data.totals;
  const withWa = data.users.filter((u) => u.whatsapp.length > 0).length;
  const delta = lastMonth.costUsd > 0 ? (thisMonth.costUsd - lastMonth.costUsd) / lastMonth.costUsd : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        icon={BrainCircuit}
        label={`IA en ${monthLabel(data.month)}`}
        value={usd(thisMonth.costUsd)}
        sub={data.usdRate ? `≈ ${ars(thisMonth.costUsd * data.usdRate)}` : "—"}
      />
      <Kpi
        icon={BrainCircuit}
        label={`IA en ${monthLabel(data.lastMonth)}`}
        value={usd(lastMonth.costUsd)}
        sub={
          delta === null
            ? data.usdRate
              ? `≈ ${ars(lastMonth.costUsd * data.usdRate)}`
              : "—"
            : `Este mes va ${delta >= 0 ? "+" : ""}${Math.round(delta * 100)} %`
        }
      />
      <Kpi icon={Users} label="Usuarios" value={String(data.users.length)} sub={`${withWa} con WhatsApp`} />
      <Kpi
        icon={Bot}
        label="Llamadas este mes"
        value={compact(thisMonth.calls)}
        sub={`${compact(thisMonth.inputTokens)} tokens entrada · ${compact(thisMonth.outputTokens)} salida`}
      />
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card className="rounded-3xl">
      <CardContent className="space-y-1 py-4">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon className="size-3.5" /> {label}
        </div>
        <div className="text-2xl font-bold tracking-tight tabular-nums">{value}</div>
        <div className="truncate text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/** Columnas de costo por mes (una serie, un color). */
function TrendCard({ data }: { data: AdminOverview }) {
  const months = [...data.byMonth].reverse();
  const max = Math.max(...months.map((m) => m.costUsd), 0.0001);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <Card className="rounded-3xl">
      <CardContent className="py-4">
        <div className="mb-3 text-sm font-semibold">Costo de IA por mes</div>
        {months.length === 0 ? (
          <Empty />
        ) : (
          <div className="relative">
            <div className="flex h-36 items-end gap-3 border-b border-border/70 px-1" role="list">
              {months.map((m, i) => (
                <div
                  key={m.month}
                  role="listitem"
                  aria-label={`${monthLabel(m.month)}: ${usd(m.costUsd)}`}
                  tabIndex={0}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="relative flex h-full flex-1 items-end justify-center outline-none"
                >
                  <div
                    className={cn("w-full max-w-6 rounded-t-[4px] bg-brand transition-opacity", hover !== null && hover !== i && "opacity-50")}
                    style={{ height: `${Math.max(2, (m.costUsd / max) * 100)}%` }}
                  />
                  {hover === i && (
                    <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg border bg-popover px-2 py-1 text-xs shadow-sm">
                      <div className="font-medium">{monthLabel(m.month)}</div>
                      <div className="tabular-nums">{usd(m.costUsd)}</div>
                      <div className="text-muted-foreground">{compact(m.calls)} llamadas</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex gap-3 px-1">
              {months.map((m) => (
                <div key={m.month} className="flex-1 text-center text-[11px] text-muted-foreground">
                  {monthLabel(m.month)}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Barras horizontales ordenadas (un color): parte de cada función o modelo. */
function BreakdownCard({ title, rows }: { title: string; rows: Array<{ label: string; bucket: AiUsageBucket }> }) {
  const sorted = [...rows].sort((a, b) => b.bucket.costUsd - a.bucket.costUsd);
  const max = Math.max(...sorted.map((r) => r.bucket.costUsd), 0.0001);
  return (
    <Card className="rounded-3xl">
      <CardContent className="py-4">
        <div className="mb-3 text-sm font-semibold">{title}</div>
        {sorted.length === 0 ? (
          <Empty />
        ) : (
          <ul className="space-y-3">
            {sorted.map((r) => (
              <li key={r.label} title={`${r.label}: ${usd(r.bucket.costUsd)} · ${r.bucket.calls} llamadas`}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">{r.label}</span>
                  <span className="shrink-0 tabular-nums font-medium">{usd(r.bucket.costUsd)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-brand"
                    style={{ width: `${Math.max(2, (r.bucket.costUsd / max) * 100)}%` }}
                  />
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{compact(r.bucket.calls)} llamadas</div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Empty() {
  return <p className="py-8 text-center text-sm text-muted-foreground">Todavía no hay consumo registrado.</p>;
}

// ---------------------------------------------------------------------------

type Pending = { user: AdminUserRow; action: AdminAction };

function UsersList({ data, onChanged }: { data: AdminOverview; onChanged: () => void }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [agent, setAgent] = useState("random");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await adminFetch(`/api/admin/users/${pending.user.uid}`, {
        method: "POST",
        body: JSON.stringify({
          action: pending.action,
          ...(pending.action === "new-agent" && agent !== "random" ? { agentName: agent } : {}),
        }),
      });
      const out = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(out.error);
      toast.success(out.message ?? "Listo");
      setPending(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "No se pudo completar");
    } finally {
      setBusy(false);
    }
  };

  const who = pending ? pending.user.name ?? pending.user.email ?? "este usuario" : "";
  const copy: Record<AdminAction, { title: string; body: string; cta: string }> = {
    "reset-memory": {
      title: "Reiniciar la charla del agente",
      body: `Se borra el historial y el borrador pendiente de ${who}. El personaje y sus datos no cambian.`,
      cta: "Reiniciar",
    },
    "new-agent": {
      title: "Cambiar el agente",
      body: `${who} va a tener un personaje nuevo (y la charla arranca de cero).`,
      cta: "Cambiar agente",
    },
    "unlink-whatsapp": {
      title: "Desvincular WhatsApp",
      body: `El número de ${who} deja de estar conectado a su cuenta. Para volver a usar el bot tiene que vincularlo de nuevo con un código.`,
      cta: "Desvincular",
    },
  };

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Usuarios ({data.users.length})</h2>
      <Card className="overflow-hidden rounded-3xl py-0">
        <ul className="divide-y">
          {data.users.map((u) => (
            <li key={u.uid} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                <Avatar className="size-9">
                  {u.photoURL && <AvatarImage src={u.photoURL} alt="" />}
                  <AvatarFallback>{(u.name ?? u.email ?? "?")[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{u.name ?? "Sin nombre"}</div>
                  <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Entró {ago(u.lastSignInAt)} · alta {ago(u.createdAt)}
                  </div>
                </div>
              </div>

              <div className="min-w-0 basis-48 text-xs">
                <div className="flex items-center gap-1.5">
                  <Bot className="size-3.5 text-muted-foreground" />
                  <span className="font-medium">{u.agentName ?? "Sin agente"}</span>
                </div>
                {u.whatsapp.length === 0 ? (
                  <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                    <MessageCircle className="size-3.5" /> Sin WhatsApp
                  </div>
                ) : (
                  u.whatsapp.map((w) => (
                    <div key={w.waId} className="mt-0.5 flex items-center gap-1.5">
                      <MessageCircle className="size-3.5 text-muted-foreground" />
                      <span className="tabular-nums">{phone(w.waId)}</span>
                      <span className="text-muted-foreground">· {ago(w.lastMessageAt)}</span>
                    </div>
                  ))
                )}
                <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                  <Smartphone className="size-3.5" /> {u.accounts} cuentas · {u.transactions} movimientos ·{" "}
                  {u.devices} {u.devices === 1 ? "dispositivo" : "dispositivos"}
                </div>
              </div>

              <div className="w-32 text-right">
                <div className="text-sm font-semibold tabular-nums">{usd(u.ai.thisMonth.costUsd)}</div>
                <div className="text-[11px] text-muted-foreground">
                  {u.ai.thisMonth.calls} llamadas · total {usd(u.ai.total.costUsd)}
                </div>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Acciones" />}>
                  <MoreVertical className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setPending({ user: u, action: "reset-memory" })}>
                    <Eraser className="mr-2 size-4" /> Reiniciar charla del agente
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setAgent("random");
                      setPending({ user: u, action: "new-agent" });
                    }}
                  >
                    <Shuffle className="mr-2 size-4" /> Cambiar agente
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={u.whatsapp.length === 0}
                    onClick={() => setPending({ user: u, action: "unlink-whatsapp" })}
                    className="text-destructive"
                  >
                    <Unlink className="mr-2 size-4" /> Desvincular WhatsApp
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      </Card>

      <Dialog open={!!pending} onOpenChange={(v) => !v && setPending(null)}>
        <DialogContent>
          {pending && (
            <>
              <DialogHeader>
                <DialogTitle>{copy[pending.action].title}</DialogTitle>
                <DialogDescription>{copy[pending.action].body}</DialogDescription>
              </DialogHeader>
              {pending.action === "new-agent" && (
                <Select value={agent} onValueChange={(v) => setAgent(v ?? "random")}>
                  <SelectTrigger className="h-10 w-full rounded-xl">
                    <SelectValue
                      items={[
                        { value: "random", label: "Al azar" },
                        ...data.agentNames.map((n) => ({ value: n, label: n })),
                      ]}
                    />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="random">Al azar</SelectItem>
                    {data.agentNames
                      .filter((n) => n !== pending.user.agentName)
                      .map((n) => (
                        <SelectItem key={n} value={n}>
                          {n}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>
                  Cancelar
                </Button>
                <Button
                  onClick={run}
                  disabled={busy}
                  variant={pending.action === "unlink-whatsapp" ? "destructive" : "default"}
                >
                  {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                  {copy[pending.action].cta}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
