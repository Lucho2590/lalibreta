"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  KeyRound,
  RefreshCw,
  Share2,
  Trash2,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccountSharesAsOwner } from "@/hooks/use-data";
import { apiFetch } from "@/lib/api";
import type { Account, ShareVisibility } from "@/lib/domain/types";

const VISIBILITY_OPTIONS: Array<{ value: ShareVisibility; label: string }> = [
  { value: "own", label: "Ve solo lo que carga" },
  { value: "all", label: "Ve todos los gastos" },
];

interface ShareCode {
  code: string;
  expiresAt: string;
  message: string;
}

export function ShareAccountSection({ account }: { account: Account }) {
  const { data: allShares } = useAccountSharesAsOwner();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [shareCode, setShareCode] = useState<ShareCode | null>(null);
  const [generating, setGenerating] = useState(false);

  const shares = useMemo(
    () =>
      allShares.filter(
        (s) => s.accountId === account.id && s.status === "active",
      ),
    [allShares, account.id],
  );

  const generateCode = async () => {
    setGenerating(true);
    try {
      const r = await apiFetch("/api/account-shares/code", {
        method: "POST",
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = (await r.json()) as ShareCode & { error?: string };
      if (!r.ok) {
        toast.error(data.error ?? "No se pudo generar el código");
        return;
      }
      setShareCode(data);
    } catch (err) {
      toast.error("No se pudo generar el código");
      console.error(err);
    } finally {
      setGenerating(false);
    }
  };

  const copyMessage = async (message: string) => {
    try {
      await navigator.clipboard.writeText(message);
      toast.success("Mensaje copiado");
    } catch {
      toast.error("No se pudo copiar");
    }
  };

  const shareMessage = async (message: string) => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text: message });
        return;
      } catch (err) {
        // Si la persona cerró el menú, no hacemos nada.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!clean) return;
    setBusy(true);
    try {
      const r = await apiFetch("/api/account-shares/create", {
        method: "POST",
        body: JSON.stringify({ accountId: account.id, granteeEmail: clean }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string; alreadyExists?: boolean };
      if (!r.ok) {
        toast.error(data.error ?? "No se pudo compartir");
        return;
      }
      toast.success(
        data.alreadyExists ? "Ya estaba compartida con esa persona" : "Cuenta compartida",
      );
      setEmail("");
    } catch (err) {
      toast.error("No se pudo compartir");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  // Solo el dueño de la cuenta decide qué ve cada persona.
  const changeVisibility = async (shareId: string, visibility: ShareVisibility, name: string) => {
    try {
      const r = await apiFetch("/api/account-shares/visibility", {
        method: "POST",
        body: JSON.stringify({ shareId, visibility }),
      });
      if (!r.ok) throw new Error();
      toast.success(
        visibility === "all"
          ? `${name} ahora ve todos los gastos de esta cuenta`
          : `${name} ahora ve solo lo que carga`,
      );
    } catch {
      toast.error("No se pudo cambiar el permiso");
    }
  };

  const revoke = async (shareId: string, name: string) => {
    if (!confirm(`Revocar acceso a ${name}? No podrá cargar más gastos en esta cuenta.`)) return;
    try {
      const r = await apiFetch("/api/account-shares/revoke", {
        method: "POST",
        body: JSON.stringify({ shareId }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t);
      }
      toast.success("Acceso revocado");
    } catch (err) {
      toast.error("No se pudo revocar");
      console.error(err);
    }
  };

  return (
    <Card className="rounded-3xl">
      <CardContent className="space-y-4 py-4">
        <div>
          <div className="text-sm font-semibold">Compartir esta cuenta</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Generá un código de un solo uso y mandáselo a quien quieras. Se suma desde la app o
            reenviándole el mensaje a su agente de WhatsApp. Lo que cargue entra directo y te
            avisamos; vos elegís si ve solo lo que carga o todos los gastos.
          </p>
        </div>

        {shareCode ? (
          <div className="space-y-3 rounded-2xl bg-muted/40 p-4 text-center">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Código para unirse
            </div>
            <div className="font-mono text-3xl font-semibold tracking-[0.3em]">
              {shareCode.code}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Vale 24 h · sirve una sola vez
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                className="h-11 bg-brand-grad text-white hover:opacity-95"
                onClick={() => shareMessage(shareCode.message)}
              >
                <Share2 className="mr-1 size-4" /> Compartir
              </Button>
              <Button
                variant="outline"
                className="h-11"
                onClick={() => copyMessage(shareCode.message)}
              >
                <Copy className="mr-1 size-4" /> Copiar
              </Button>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={generateCode}
              disabled={generating}
            >
              <RefreshCw className="size-3" /> Generar otro
            </button>
          </div>
        ) : (
          <Button
            className="h-11 w-full bg-brand-grad text-white hover:opacity-95"
            onClick={generateCode}
            disabled={generating}
          >
            <KeyRound className="mr-1 size-4" />
            {generating ? "Generando…" : "Generar código para compartir"}
          </Button>
        )}

        {showEmail ? (
          <form onSubmit={submit} className="space-y-1">
            <div className="flex gap-2">
              <div className="flex-1">
                <Label htmlFor="share-email" className="sr-only">
                  Email
                </Label>
                <Input
                  id="share-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="email@ejemplo.com"
                  className="h-11"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                className="h-11"
                disabled={busy || !email.trim()}
              >
                <UserPlus className="mr-1 size-4" /> Invitar
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Por email, cada gasto que cargue te queda pendiente de aprobación.
            </p>
          </form>
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowEmail(true)}
          >
            o invitar por email <ChevronDown className="size-3" />
          </button>
        )}

        {shares.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Compartida con</div>
            {shares.map((s) => {
              const display = s.granteeDisplayName || s.granteeEmail || "Alguien";
              return (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/40 p-2"
                >
                  <Avatar className="size-9">
                    <AvatarFallback>
                      {display[0]?.toUpperCase() ?? "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{display}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {s.granteeEmail}
                      {s.mode === "direct" ? " · carga directo" : " · con aprobación"}
                    </div>
                  </div>
                  {s.granteeUid ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                      <CheckCircle2 className="size-3" /> En la app
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <Circle className="size-3" /> Sin registrar
                    </span>
                  )}
                  <Select
                    value={s.visibility === "all" ? "all" : "own"}
                    onValueChange={(v) => v && changeVisibility(s.id, v as ShareVisibility, display)}
                  >
                    <SelectTrigger className="h-8 w-[170px] rounded-lg bg-background text-xs" aria-label="Qué puede ver">
                      <SelectValue items={VISIBILITY_OPTIONS} />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      {VISIBILITY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => revoke(s.id, display)}
                    aria-label="Revocar"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
