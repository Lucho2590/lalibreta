"use client";

import { MoreVertical, Pencil, Receipt, Trash2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ListItem } from "@/lib/domain/list-model";
import type { Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ItemRowActions {
  onToggle: (item: ListItem, done: boolean) => void;
  onEdit: (item: ListItem) => void;
  onAddExpense: (item: ListItem) => void;
  onUnlinkExpense: (item: ListItem) => void;
  onDelete: (item: ListItem) => void;
}

export function ItemRow({
  item,
  currency,
  myUid,
  editable,
  actions,
}: {
  item: ListItem;
  currency: Currency;
  myUid: string;
  editable: boolean;
  actions: ItemRowActions;
}) {
  const expenses = Object.entries(item.expenses ?? {});
  const mine = item.expenses?.[myUid];

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <input
        type="checkbox"
        className="mt-0.5 size-5 shrink-0 accent-brand disabled:opacity-60"
        checked={item.done}
        disabled={!editable}
        onChange={(e) => actions.onToggle(item, e.target.checked)}
        aria-label={item.done ? `Destildar ${item.title}` : `Tildar ${item.title}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("text-sm font-medium", item.done && "text-muted-foreground line-through")}>
            {item.title}
          </span>
          {item.quantity && <span className="text-xs text-muted-foreground">{item.quantity}</span>}
        </div>
        {(item.estimatedAmount || expenses.length > 0 || item.notes) && (
          <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
            {expenses.length > 0 ? (
              <div className="flex flex-wrap gap-x-2">
                {expenses.map(([uid, e]) => (
                  <span key={uid} className="inline-flex items-center gap-1">
                    <Receipt className="size-3" />
                    <span className="font-medium tabular-nums text-foreground">{formatMoney(e.amount, e.currency)}</span>
                    {uid === myUid ? "· vos" : e.byName ? `· ${e.byName.split(" ")[0]}` : ""}
                  </span>
                ))}
              </div>
            ) : (
              item.estimatedAmount && <div className="tabular-nums">≈ {formatMoney(item.estimatedAmount, currency)}</div>
            )}
            {item.notes && <div className="line-clamp-2">{item.notes}</div>}
          </div>
        )}
      </div>
      {editable && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="-mr-2 -mt-1 size-8 shrink-0" aria-label="Opciones" />}
          >
            <MoreVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {mine ? (
              <DropdownMenuItem onClick={() => actions.onUnlinkExpense(item)}>
                <Unlink className="mr-2 size-4" /> Desvincular mi gasto
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => actions.onAddExpense(item)}>
                <Receipt className="mr-2 size-4" /> Cargar gasto
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => actions.onEdit(item)}>
              <Pencil className="mr-2 size-4" /> Editar
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(item)}>
              <Trash2 className="mr-2 size-4" /> Eliminar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
