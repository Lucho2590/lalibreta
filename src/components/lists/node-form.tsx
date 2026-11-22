"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts } from "@/hooks/use-data";
import { createNode, updateNode, type ListNode, type ListNodeKind } from "@/lib/domain/lists";
import { userCurrencies, type Currency } from "@/lib/domain/types";
import { currencyOptionLabel, formatAmountInput, parseAmount } from "@/lib/format";
import { cn } from "@/lib/utils";

const EMOJIS = ["🛒", "🎂", "🎉", "🎁", "🏠", "✈️", "🍖", "📚", "💊", "🧹", "👕", "🐶"];

const PLACEHOLDER: Record<ListNodeKind, string> = {
  list: "Super, invitados, regalos…",
  group: "Mi cumple, viaje a Bariloche, mudanza…",
};

/** Nuevo grupo o lista (adentro de `parent` si viene), o edición de uno existente. */
export function NodeForm({
  node,
  kind: kindProp,
  parent,
  onDone,
}: {
  node?: ListNode;
  kind?: ListNodeKind;
  parent?: ListNode | null;
  onDone?: (id: string) => void;
}) {
  const { user } = useAuth();
  const kind = node?.kind ?? kindProp ?? "list";
  const [title, setTitle] = useState(node?.title ?? "");
  const [emoji, setEmoji] = useState<string | null>(node?.emoji ?? null);
  const [dueDate, setDueDate] = useState(node?.dueDate ?? "");
  const [budget, setBudget] = useState(node?.budget ? formatAmountInput(String(node.budget).replace(".", ",")) : "");
  const [currency, setCurrency] = useState<Currency>(node?.currency ?? parent?.currency ?? "ARS");
  const [notes, setNotes] = useState(node?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const { data: accounts } = useAccounts();
  const currencyChoices = [...new Set<Currency>(["ARS", ...userCurrencies(accounts), currency])];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!title.trim()) return toast.error(kind === "group" ? "Ponele un nombre al grupo" : "Ponele un nombre a la lista");
    const cap = budget.trim() ? parseAmount(budget) : null;
    if (cap != null && !(cap > 0)) return toast.error("El tope no es válido (ej. 300.000)");
    setSaving(true);
    try {
      const input = { title, emoji, notes, dueDate: dueDate || null, budget: cap, currency };
      if (node) {
        await updateNode(node.id, input);
        toast.success("Guardado");
        onDone?.(node.id);
      } else {
        const id = await createNode(
          { uid: user.uid, email: user.email ?? "", displayName: user.displayName, photoURL: user.photoURL },
          parent ?? null,
          kind,
          input,
        );
        toast.success(kind === "group" ? "Grupo creado" : "Lista creada");
        onDone?.(id);
      }
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {parent && (
        <p className="text-xs text-muted-foreground">
          Adentro de <span className="font-medium text-foreground">{parent.title}</span>
          {parent.members.length > 1 && " (la ven las mismas personas)"}
        </p>
      )}
      <div className="space-y-1">
        <Label htmlFor="node-title">Nombre</Label>
        <Input
          id="node-title"
          className="h-12 text-base"
          placeholder={PLACEHOLDER[kind]}
          value={title}
          maxLength={80}
          autoFocus={!node}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Ícono</Label>
        <div className="flex flex-wrap gap-1.5">
          {EMOJIS.map((em) => (
            <button
              key={em}
              type="button"
              onClick={() => setEmoji(emoji === em ? null : em)}
              className={cn(
                "flex size-9 items-center justify-center rounded-xl border text-lg transition",
                emoji === em ? "border-primary bg-primary/10" : "border-transparent bg-muted hover:bg-muted/70",
              )}
              aria-pressed={emoji === em}
            >
              {em}
            </button>
          ))}
          {emoji && !EMOJIS.includes(emoji) && (
            <span className="flex size-9 items-center justify-center rounded-xl border border-primary bg-primary/10 text-lg">
              {emoji}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="node-due">Fecha de finalización</Label>
          <div className="relative">
            <Input
              id="node-due"
              type="date"
              className="h-12"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            {dueDate && (
              <button
                type="button"
                onClick={() => setDueDate("")}
                aria-label="Sacar la fecha"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">Opcional</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="node-budget">Máximo a gastar</Label>
          <Input
            id="node-budget"
            inputMode="decimal"
            autoComplete="off"
            className="h-12"
            placeholder="Opcional"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={(e) => setBudget(formatAmountInput(e.target.value))}
          />
          {currencyChoices.length > 1 && (
            <div className="mt-1 inline-flex flex-wrap rounded-lg bg-muted p-0.5">
              {currencyChoices.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCurrency(c)}
                  className={cn(
                    "h-7 rounded-md px-2.5 text-xs font-medium transition",
                    currency === c ? "bg-background shadow-sm" : "text-muted-foreground",
                  )}
                >
                  {currencyOptionLabel(c)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {kind === "group" && (
        <p className="-mt-2 text-[11px] text-muted-foreground">
          El grupo suma lo que se gaste en todas las listas de adentro.
        </p>
      )}

      <div className="space-y-1">
        <Label htmlFor="node-notes">Notas</Label>
        <textarea
          id="node-notes"
          rows={2}
          maxLength={500}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          placeholder="Opcional"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={saving}>
        {saving ? "Guardando…" : node ? "Guardar cambios" : kind === "group" ? "Crear grupo" : "Crear lista"}
      </Button>
    </form>
  );
}
