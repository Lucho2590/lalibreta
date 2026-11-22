"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateItem, type ListItem } from "@/lib/domain/lists";
import type { Currency } from "@/lib/domain/types";
import { currencySymbol, formatAmountInput, parseAmount } from "@/lib/format";

/** Editar un ítem: nombre, cantidad, precio estimado y notas. */
export function ItemForm({
  listId,
  item,
  currency,
  onDone,
}: {
  listId: string;
  item: ListItem;
  currency: Currency;
  onDone?: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [quantity, setQuantity] = useState(item.quantity ?? "");
  const [estimated, setEstimated] = useState(item.estimatedAmount ? formatAmountInput(String(item.estimatedAmount)) : "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return toast.error("Poné qué es");
    const est = estimated.trim() ? parseAmount(estimated) : null;
    if (est != null && !(est > 0)) return toast.error("El precio no es válido (ej. 2.500)");
    setSaving(true);
    try {
      await updateItem(listId, item.id, { title, quantity, notes, estimatedAmount: est });
      onDone?.();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="item-title">Qué</Label>
        <Input
          id="item-title"
          className="h-12 text-base"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="item-qty">Cantidad</Label>
          <Input
            id="item-qty"
            className="h-12"
            placeholder="2 kg, x3…"
            value={quantity}
            maxLength={40}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="item-est">Precio estimado ({currencySymbol(currency)})</Label>
          <Input
            id="item-est"
            inputMode="decimal"
            autoComplete="off"
            className="h-12"
            placeholder="Opcional"
            value={estimated}
            onChange={(e) => setEstimated(e.target.value)}
            onBlur={(e) => setEstimated(formatAmountInput(e.target.value))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="item-notes">Notas</Label>
        <textarea
          id="item-notes"
          rows={2}
          maxLength={300}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          placeholder="Marca, dónde comprarlo…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={saving}>
        {saving ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}
