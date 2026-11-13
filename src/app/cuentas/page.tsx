"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  CreditCard,
  GripVertical,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AccountIcon, defaultIconForType } from "@/components/account-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts, useAllInstallments } from "@/hooks/use-data";
import { computeAccountBalances, type AccountBalance } from "@/lib/domain/balances";
import { accountCurrencies, paymentMonthOf, type Currency, type Installment } from "@/lib/domain/types";
import { formatMoney, formatShortDate } from "@/lib/format";
import { summarizeCardMonth } from "@/lib/domain/card-summary";
import { AccountForm } from "@/components/accounts/account-form";
import { SharedWithMeSection } from "@/components/accounts/shared-with-me-section";
import {
  deleteAccount,
  saveAccountOrder,
  setAccountActive,
  sortAccounts,
} from "@/lib/domain/accounts";
import type { Account, AccountType } from "@/lib/domain/types";

const typeLabel: Record<AccountType, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Tarjeta de crédito",
  checking: "Cuenta corriente",
  savings: "Caja de ahorro",
  digital: "Billetera virtual",
  reserve: "Cobacha",
};

const AccountAvatar = ({ icon, type }: { icon?: string; type: AccountType }) => (
  <div className="flex size-11 items-center justify-center rounded-2xl bg-brand-grad text-white shadow-sm">
    <AccountIcon name={icon ?? defaultIconForType(type)} className="size-5" />
  </div>
);

export default function AccountsPage() {
  const { user } = useAuth();
  const { data: accounts, loading } = useAccounts();
  const { data: allInstallments } = useAllInstallments();
  const balances = useMemo(
    () => computeAccountBalances(accounts, allInstallments),
    [accounts, allInstallments],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  // Cuentas madre plegadas (se recuerda en este navegador).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      return new Set(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });

  // Orden optimista: se aplica en pantalla al soltar, sin esperar a Firestore
  // (si no, la lista vuelve un instante al orden viejo y "salta").
  const [orderOverride, setOrderOverride] = useState<Record<string, number>>({});
  const reorder = async (orderedIds: string[]) => {
    if (!user) return;
    const patch = Object.fromEntries(orderedIds.map((id, i) => [id, i]));
    setOrderOverride((prev) => ({ ...prev, ...patch }));
    try {
      await saveAccountOrder(user.uid, orderedIds);
    } catch (err) {
      toast.error("No se pudo guardar el orden");
      console.error(err);
      setOrderOverride((prev) => {
        const next = { ...prev };
        for (const id of orderedIds) delete next[id];
        return next;
      });
    }
  };
  const sorted = <T extends Account>(list: T[]) =>
    sortAccounts(
      list.map((a) => (a.id in orderOverride ? { ...a, sortOrder: orderOverride[a.id] } : a)),
    );

  const childrenByParent = useMemo(() => {
    const m = new Map<string, Account[]>();
    for (const a of accounts) {
      if (a.parentId) {
        const arr = m.get(a.parentId) ?? [];
        arr.push(a);
        m.set(a.parentId, arr);
      }
    }
    return m;
  }, [accounts]);

  const togglePause = async (acc: Account) => {
    if (!user) return;
    try {
      await setAccountActive(user.uid, acc.id, acc.active === false);
      toast.success(acc.active === false ? "Cuenta reactivada" : "Cuenta pausada");
    } catch (err) {
      toast.error("No se pudo actualizar");
      console.error(err);
    }
  };

  const remove = async (acc: Account) => {
    if (!user) return;
    const children = childrenByParent.get(acc.id) ?? [];
    const msg =
      children.length > 0
        ? `Eliminar "${acc.name}". Las ${children.length} ${children.length === 1 ? "tarjeta queda" : "tarjetas quedan"} sin cuenta padre y los movimientos pasados se mantienen sin cuenta. ¿Continuar?`
        : `Eliminar "${acc.name}". Los movimientos pasados se mantendrán sin cuenta. ¿Continuar?`;
    if (!confirm(msg)) return;
    try {
      await deleteAccount(user.uid, acc.id);
      toast.success("Cuenta eliminada");
    } catch (err) {
      toast.error("No se pudo eliminar");
      console.error(err);
    }
  };

  const renderMenu = (acc: Account) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Opciones"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        }
      >
        <MoreVertical className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.preventDefault()}>
        <DropdownMenuItem onClick={() => setEditing(acc)}>
          <Pencil className="mr-2 size-4" /> Editar
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => togglePause(acc)}>
          {acc.active === false ? (
            <>
              <Play className="mr-2 size-4" /> Reanudar
            </>
          ) : (
            <>
              <Pause className="mr-2 size-4" /> Pausar
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => remove(acc)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 size-4" /> Eliminar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /** Tarjeta de una cuenta madre. En la copia flotante no lleva link ni botones. */
  const parentCard = (
    acc: Account,
    opts: { handle?: React.ReactNode; overlay?: boolean },
  ) => {
    const children = childrenByParent.get(acc.id) ?? [];
    const paused = acc.active === false;
    const isCollapsed = collapsed.has(acc.id);
    const content = (
      <Card className="rounded-2xl transition hover:shadow-md active:scale-[0.99]">
        <CardContent
          className="flex items-center gap-3 py-4 pl-8 pr-20"
        >
          <AccountAvatar icon={acc.icon} type={acc.type} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">
                {acc.isMain && <span title="Cuenta principal">⭐ </span>}
                {acc.name}
              </span>
              {paused && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Pausada
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {typeLabel[acc.type]}
              {acc.type === "credit" && acc.last4 ? ` ···· ${acc.last4}` : ""}
              {acc.type === "credit"
                ? acc.defaultClosingDay
                  ? ` · cierre día ${acc.defaultClosingDay}`
                  : " · fechas pendientes"
                : ""}
              {children.length > 0 ? ` · ${childrenSummary(children)}` : ""}
            </div>
          </div>
          <BalanceAmounts account={acc} balance={balances.get(acc.id)} installments={allInstallments} />
        </CardContent>
      </Card>
    );
    return (
      <div className="relative">
        <div className="absolute left-1 top-1/2 z-10 -translate-y-1/2">
          {opts.overlay ? <GripIcon /> : opts.handle}
        </div>
        {opts.overlay ? (
          content
        ) : (
          <Link href={`/cuentas/${acc.id}`} className={paused ? "opacity-60" : ""}>
            {content}
          </Link>
        )}
        {!opts.overlay && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
            {children.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={isCollapsed ? "Mostrar tarjetas y cobachas" : "Ocultar tarjetas y cobachas"}
                aria-expanded={!isCollapsed}
                onClick={() => toggleCollapsed(acc.id)}
              >
                <ChevronDown
                  className={`size-4 transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}`}
                />
              </Button>
            )}
            {renderMenu(acc)}
          </div>
        )}
      </div>
    );
  };

  /** Tarjeta de una tarjeta de crédito o cobacha dentro de su cuenta. */
  const childCard = (
    card: Account,
    opts: { handle?: React.ReactNode; overlay?: boolean },
  ) => {
    const cardPaused = card.active === false;
    const content = (
      <Card className="rounded-xl transition hover:shadow-sm active:scale-[0.99]">
        <CardContent className="flex items-center gap-3 py-3 pl-7 pr-10">
          <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground">
            <AccountIcon name={card.icon ?? defaultIconForType(card.type)} className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{card.name}</span>
              {cardPaused && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Pausada
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {typeLabel[card.type]}
              {card.last4 ? ` ···· ${card.last4}` : ""}
              {card.type !== "credit"
                ? ""
                : card.defaultClosingDay
                  ? ` · cierre día ${card.defaultClosingDay}`
                  : " · fechas pendientes"}
            </div>
          </div>
          <BalanceAmounts account={card} balance={balances.get(card.id)} installments={allInstallments} small />
        </CardContent>
      </Card>
    );
    return (
      <div className="relative">
        <div className="absolute left-0.5 top-1/2 z-10 -translate-y-1/2">
          {opts.overlay ? <GripIcon /> : opts.handle}
        </div>
        {opts.overlay ? (
          content
        ) : (
          <Link href={`/cuentas/${card.id}`} className={cardPaused ? "opacity-60" : ""}>
            {content}
          </Link>
        )}
        {!opts.overlay && (
          <div className="absolute right-1 top-1/2 -translate-y-1/2">{renderMenu(card)}</div>
        )}
      </div>
    );
  };

  const topLevel = accounts.filter((a) => !a.parentId);
  const orphanCards = accounts.filter(
    (a) => a.parentId && !accounts.some((p) => p.id === a.parentId),
  );
  const groups = sorted([...topLevel, ...orphanCards]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cuentas</h1>
          <p className="text-sm text-muted-foreground">
            Arrastrá <GripVertical className="inline size-3.5 align-text-bottom" /> para ordenarlas a tu gusto
          </p>
        </div>
        <Sheet open={createOpen} onOpenChange={setCreateOpen}>
          <SheetTrigger
            render={<Button className="bg-brand-grad text-white hover:opacity-95" />}
          >
            <Plus className="mr-1 size-4" /> Nueva cuenta
          </SheetTrigger>
          <SheetContent side="bottom" className="sheet-md-modal p-0">
            <SheetHeader className="px-5 pt-5">
              <SheetTitle>Nueva cuenta</SheetTitle>
            </SheetHeader>
            <div className="px-5 pb-6 pt-3">
              <AccountForm onCreated={() => setCreateOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <Sheet open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <SheetContent side="bottom" className="sheet-md-modal p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Editar cuenta</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-3">
            {editing && (
              <AccountForm account={editing} onUpdated={() => setEditing(null)} />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!loading && accounts.length === 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-16 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
              <CreditCard className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Todavía no creaste ninguna cuenta</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Empezá agregando una tarjeta o tu efectivo.
            </p>
          </CardContent>
        </Card>
      )}

      <SharedWithMeSection />

      <SortableList
        ids={groups.map((g) => g.id)}
        onReorder={reorder}
        renderOverlay={(id) => {
          const acc = groups.find((g) => g.id === id);
          return acc ? parentCard(acc, { overlay: true }) : null;
        }}
      >
        <div className="space-y-3">
          {groups.map((acc) => {
            const children = sorted(childrenByParent.get(acc.id) ?? []);
            const isCollapsed = collapsed.has(acc.id);
            return (
              <SortableItem key={acc.id} id={acc.id}>
                {(handle) => (
                  <div className="space-y-2">
                    {parentCard(acc, { handle })}

                    {children.length > 0 && !isCollapsed && (
                      <SortableList
                        ids={children.map((c) => c.id)}
                        onReorder={reorder}
                        renderOverlay={(id) => {
                          const card = children.find((c) => c.id === id);
                          return card ? childCard(card, { overlay: true }) : null;
                        }}
                      >
                        <div className="ml-5 space-y-2 border-l-2 border-border pl-3">
                          {children.map((card) => (
                            <SortableItem key={card.id} id={card.id}>
                              {(childHandle) => childCard(card, { handle: childHandle })}
                            </SortableItem>
                          ))}
                        </div>
                      </SortableList>
                    )}
                  </div>
                )}
              </SortableItem>
            );
          })}
        </div>
      </SortableList>
    </div>
  );
}

const COLLAPSED_KEY = "cuentas-colapsadas";

/** Ícono de "agarrar" (en la copia flotante es solo decorativo). */
const GripIcon = () => (
  <span className="flex size-7 items-center justify-center text-muted-foreground">
    <GripVertical className="size-4" />
  </span>
);

const dropAnimation: DropAnimation = {
  duration: 220,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.35" } } }),
};

/**
 * Lista ordenable con arrastrar y soltar (mouse, teclado y touch). Mientras
 * se arrastra se muestra una copia flotante (renderOverlay) y en la lista
 * queda un hueco tenue donde va a caer.
 */
function SortableList({
  ids,
  onReorder,
  renderOverlay,
  children,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  renderOverlay: (id: string) => React.ReactNode;
  children: React.ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeId ? (
          <div className="scale-[1.02] cursor-grabbing rounded-2xl shadow-xl ring-1 ring-black/5">
            {renderOverlay(activeId)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableItem({
  id,
  children,
}: {
  id: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, transition: { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" } });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label="Arrastrar para ordenar"
      className="flex size-7 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:cursor-grabbing"
    >
      <GripVertical className="size-4" />
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{
        // Solo desplazamiento vertical: sin estirar ni achicar la tarjeta.
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={isDragging ? "opacity-35" : undefined}
    >
      {children(handle)}
    </div>
  );
}

/** Saldo (cuentas) o lo que se debe (tarjetas), por moneda. */
function BalanceAmounts({
  account,
  balance,
  installments,
  small,
}: {
  account: Account;
  balance?: AccountBalance;
  installments: Installment[];
  small?: boolean;
}) {
  if (account.type === "credit") {
    // Tarjeta: lo que falta pagar del resumen que vence este mes.
    const s = summarizeCardMonth(installments, [account.id], paymentMonthOf(new Date()));
    const owed = (["ARS", "USD"] as Currency[]).filter((c) => s.pending[c] > 0.009);
    if (owed.length === 0) return null;
    return (
      <div className={`text-right tabular-nums ${small ? "text-xs" : "text-sm"}`}>
        <div className="text-[10px] text-muted-foreground">
          {s.dueDate ? `vence ${formatShortDate(s.dueDate)}` : "a pagar"}
        </div>
        {owed.map((c) => (
          <div key={c} className="font-semibold">
            {formatMoney(s.pending[c], c)}
          </div>
        ))}
      </div>
    );
  }
  if (!balance) return null;
  return (
    <div className={`text-right tabular-nums ${small ? "text-xs" : "text-sm"}`}>
      {accountCurrencies(account).map((c) => (
        <div key={c} className="font-semibold">
          {formatMoney(balance.amounts[c], c)}
        </div>
      ))}
    </div>
  );
}

const childrenSummary = (children: Account[]) => {
  const cards = children.filter((c) => c.type === "credit").length;
  const reserves = children.filter((c) => c.type === "reserve").length;
  return [
    cards ? `${cards} ${cards === 1 ? "tarjeta" : "tarjetas"}` : null,
    reserves ? `${reserves} ${reserves === 1 ? "cobacha" : "cobachas"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
};
