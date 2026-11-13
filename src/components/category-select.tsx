"use client";

import { CategoryIcon } from "@/components/category-icon";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import type { Category } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

/**
 * Desplegable de categorías con el estilo de la app: ícono + nombre en el
 * campo y en la lista, y se abre debajo del campo (no encima, como el nativo).
 */
export function CategorySelect({
  value,
  onChange,
  groups,
  placeholder = "Elegí una categoría",
  warn = false,
  className,
}: {
  value: string | null;
  onChange: (categoryId: string) => void;
  /** Una o más listas (ej. gastos e ingresos), cada una con su título opcional. */
  groups: Array<{ label?: string; categories: Category[] }>;
  placeholder?: string;
  /** Resalta el campo (ej. falta elegir). */
  warn?: boolean;
  className?: string;
}) {
  const all = groups.flatMap((g) => g.categories);
  const current = all.find((c) => c.id === value);
  const visibleGroups = groups.filter((g) => g.categories.length > 0);

  return (
    <Select value={value ?? ""} onValueChange={(v) => onChange(String(v ?? ""))}>
      <SelectTrigger
        className={cn(
          "h-9 w-full bg-background",
          warn && !current && "border-amber-400 ring-2 ring-amber-400/20",
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {current ? (
            <>
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted">
                <CategoryIcon name={current.icon} className="size-3" />
              </span>
              <span className="truncate">{current.name}</span>
            </>
          ) : (
            <span className="truncate text-muted-foreground">{placeholder}</span>
          )}
        </span>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start" className="max-h-72 min-w-56">
        {visibleGroups.map((g, i) => (
          <SelectGroup key={g.label ?? i}>
            {i > 0 && <SelectSeparator />}
            {g.label && <SelectLabel>{g.label}</SelectLabel>}
            {g.categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted">
                  <CategoryIcon name={c.icon} className="size-3" />
                </span>
                {c.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
