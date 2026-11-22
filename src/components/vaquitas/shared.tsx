"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CURRENCIES, type Currency } from "@/lib/domain/types";
import { currencySymbol } from "@/lib/format";

export const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const num = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
export const ddmm = (ymd: string) => ymd.split("-").reverse().slice(0, 2).join("/");

/** Botón tipo "pastilla" para elegir (personas, familias, monedas). */
export function Chip({
  active,
  onClick,
  children,
  className,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "h-9 rounded-full border px-3 text-sm font-medium transition disabled:opacity-50",
        active ? "border-brand bg-brand/10 text-brand" : "border-border text-muted-foreground hover:bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Selector segmentado (como el de "Me pasó / Le pasé"). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="grid gap-1 rounded-xl bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-9 rounded-lg text-xs font-medium transition",
            value === o.value ? "bg-background shadow-sm" : "text-muted-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CurrencyPicker({
  value,
  onChange,
  options = CURRENCIES,
}: {
  value: Currency;
  onChange: (c: Currency) => void;
  options?: readonly Currency[];
}) {
  return (
    <div className="inline-flex min-h-12 flex-wrap rounded-lg bg-muted p-1">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            "rounded-md px-3 text-xs font-medium",
            value === c ? "bg-background shadow-sm" : "text-muted-foreground",
          )}
        >
          {currencySymbol(c)}
        </button>
      ))}
    </div>
  );
}

export interface FamilyDraft {
  id: string;
  name: string;
}

let famSeq = 0;
export const newFamilyId = () => `f_new${Date.now().toString(36)}${(famSeq++).toString(36)}`;

/**
 * Armar familias: nombre de cada una y en cuál va cada persona. Una familia
 * cuenta como una sola parte en la vaquita.
 */
export function FamiliesEditor({
  people,
  families,
  assignment,
  onChange,
}: {
  people: Array<{ key: string; name: string }>;
  families: FamilyDraft[];
  assignment: Record<string, string | null>;
  onChange: (families: FamilyDraft[], assignment: Record<string, string | null>) => void;
}) {
  const setName = (id: string, name: string) =>
    onChange(
      families.map((f) => (f.id === id ? { ...f, name } : f)),
      assignment,
    );
  const add = () => onChange([...families, { id: newFamilyId(), name: `Familia ${families.length + 1}` }], assignment);
  const remove = (id: string) =>
    onChange(
      families.filter((f) => f.id !== id),
      Object.fromEntries(Object.entries(assignment).map(([k, v]) => [k, v === id ? null : v])),
    );
  const assign = (key: string, familyId: string | null) => onChange(families, { ...assignment, [key]: familyId });

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {families.map((f) => (
          <div key={f.id} className="flex items-center gap-2">
            <Input value={f.name} onChange={(e) => setName(f.id, e.target.value)} className="h-10" placeholder="Nombre de la familia" />
            <Button type="button" size="icon" variant="ghost" className="text-muted-foreground" onClick={() => remove(f.id)} aria-label="Quitar familia">
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="mr-1 size-4" /> Agregar familia
        </Button>
      </div>
      {families.length > 0 && (
        <div className="divide-y rounded-xl border">
          {people.map((p) => (
            <div key={p.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-24 flex-1 text-sm font-medium">{p.name}</span>
              <div className="flex flex-wrap gap-1">
                {families.map((f) => (
                  <Chip key={f.id} className="h-8 px-2.5 text-xs" active={assignment[p.key] === f.id} onClick={() => assign(p.key, f.id)}>
                    {f.name || "Sin nombre"}
                  </Chip>
                ))}
                <Chip className="h-8 px-2.5 text-xs" active={!assignment[p.key]} onClick={() => assign(p.key, null)}>
                  Suelto
                </Chip>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
