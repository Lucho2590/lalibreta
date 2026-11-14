"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Circle, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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

export function ShareAccountSection({ account }: { account: Account }) {
  const { data: allShares } = useAccountSharesAsOwner();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const shares = useMemo(
    () =>
      allShares.filter(
        (s) => s.accountId === account.id && s.status === "active",
      ),
    [allShares, account.id],
  );

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
          <div className="text-sm font-semibold">Compartida con</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Otros pueden cargar gastos en esta cuenta. Vos elegís qué ve cada uno: solo lo que carga o todos los gastos.
          </p>
        </div>

        <form onSubmit={submit} className="flex gap-2">
          <div className="flex-1 space-y-1">
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
            className="h-11 bg-brand-grad text-white hover:opacity-95"
            disabled={busy || !email.trim()}
          >
            <UserPlus className="mr-1 size-4" /> Compartir
          </Button>
        </form>

        {shares.length > 0 && (
          <div className="space-y-2">
            {shares.map((s) => {
              const display = s.granteeDisplayName || s.granteeEmail;
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
