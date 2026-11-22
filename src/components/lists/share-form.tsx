"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ParticipantsPicker } from "@/components/agenda/participants-picker";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/api";
import { personName, roleLabel, type ListNode, type ListShare, type ShareRole } from "@/lib/domain/list-model";
import { cn } from "@/lib/utils";

/**
 * Con quién se comparte un grupo o lista y con qué permiso. Lo compartido en
 * un grupo vale para todo lo de adentro; acá se muestra también lo heredado.
 */
export function ShareForm({
  node,
  ancestors,
  onDone,
}: {
  node: ListNode;
  ancestors: ListNode[];
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const [shares, setShares] = useState<ListShare[]>(node.shares ?? []);
  const [saving, setSaving] = useState(false);

  // Lo heredado de los grupos de arriba (no se edita acá).
  const inherited = new Map<string, { role: ShareRole; from: string; person: ListShare }>();
  for (const a of ancestors) {
    for (const s of a.shares ?? []) {
      const prev = inherited.get(s.email);
      if (!prev || (prev.role === "view" && s.role === "edit")) inherited.set(s.email, { role: s.role, from: a.title, person: s });
    }
  }

  const setRole = (email: string, role: ShareRole) =>
    setShares((xs) => xs.map((s) => (s.email === email ? { ...s, role } : s)));

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiFetch("/api/lists/share", {
        method: "POST",
        body: JSON.stringify({ nodeId: node.id, shares }),
      });
      const data = (await r.json().catch(() => null)) as
        | { error?: string; added?: number; notified?: number; emailed?: number }
        | null;
      if (!r.ok) throw new Error(data?.error ?? "No se pudo compartir");
      const told = (data?.notified ?? 0) + (data?.emailed ?? 0);
      toast.success(told > 0 ? `Compartida. Les avisamos a ${told} ${told === 1 ? "persona" : "personas"}` : "Guardado");
      onDone?.();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error && err.message ? err.message : "No se pudo compartir");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {node.kind === "group"
          ? "Las personas que sumes ven este grupo con todas sus listas, también las que se agreguen después."
          : "Las personas que sumes ven esta lista."}{" "}
        Con <b>Puede editar</b> tildan, agregan cosas y cargan lo que gastan desde su cuenta.
      </p>

      {inherited.size > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Ya la ven por un grupo de arriba</Label>
          {[...inherited.values()].map(({ person, role, from }) => (
            <div key={person.email} className="flex items-center gap-2 text-sm">
              <Avatar className="size-6">
                {person.photoURL && <AvatarImage src={person.photoURL} alt="" />}
                <AvatarFallback className="text-[10px]">{personName(person)[0]?.toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate">{personName(person)}</span>
              <span className="text-xs text-muted-foreground">
                {roleLabel(role)} · por {from}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Label>Compartir con</Label>
        <ParticipantsPicker
          value={shares}
          onChange={(v) =>
            setShares(
              v.map((p) => {
                const prev = shares.find((s) => s.email === p.email);
                return prev ?? { ...p, uid: p.uid ?? null, role: "edit" as const };
              }),
            )
          }
          excludeEmail={user?.email}
        />
      </div>

      {shares.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Permisos</Label>
          {shares.map((s) => (
            <div key={s.email} className="flex items-center gap-2">
              <Avatar className="size-7">
                {s.photoURL && <AvatarImage src={s.photoURL} alt="" />}
                <AvatarFallback className="text-[10px]">{personName(s)[0]?.toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{personName(s)}</div>
                {!s.uid && <div className="text-[11px] text-muted-foreground">Sin cuenta: le llega un mail</div>}
              </div>
              <div className="inline-flex rounded-lg bg-muted p-0.5">
                {(["view", "edit"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(s.email, r)}
                    className={cn(
                      "h-7 rounded-md px-2.5 text-xs font-medium transition",
                      s.role === r ? "bg-background shadow-sm" : "text-muted-foreground",
                    )}
                  >
                    {r === "view" ? "Ver" : "Editar"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Button className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={saving} onClick={save}>
        {saving ? "Guardando…" : "Guardar"}
      </Button>
    </div>
  );
}
