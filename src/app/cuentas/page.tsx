"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ChevronRight,
  CreditCard,
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
import { useAccounts } from "@/hooks/use-data";
import { AccountForm } from "@/components/accounts/account-form";
import {
  deleteAccount,
  setAccountActive,
} from "@/lib/domain/accounts";
import type { Account, AccountType } from "@/lib/domain/types";

const typeLabel: Record<AccountType, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Tarjeta de crédito",
  checking: "Cuenta corriente",
  savings: "Caja de ahorro",
  digital: "Billetera virtual",
};

const AccountAvatar = ({ icon, type }: { icon?: string; type: AccountType }) => (
  <div className="flex size-11 items-center justify-center rounded-2xl bg-brand-grad text-white shadow-sm">
    <AccountIcon name={icon ?? defaultIconForType(type)} className="size-5" />
  </div>
);

export default function AccountsPage() {
  const { user } = useAuth();
  const { data: accounts, loading } = useAccounts();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

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

  const topLevel = accounts.filter((a) => !a.parentId);
  const orphanCards = accounts.filter(
    (a) => a.parentId && !accounts.some((p) => p.id === a.parentId),
  );
  const groups = [...topLevel, ...orphanCards];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cuentas</h1>
          <p className="text-sm text-muted-foreground">
            Efectivo, débito, crédito y más
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

      <div className="space-y-3">
        {groups.map((acc) => {
          const children = childrenByParent.get(acc.id) ?? [];
          const paused = acc.active === false;
          return (
            <div key={acc.id} className="space-y-2">
              <div className="relative">
                <Link
                  href={`/cuentas/${acc.id}`}
                  className={paused ? "opacity-60" : ""}
                >
                  <Card className="rounded-2xl transition hover:shadow-md active:scale-[0.99]">
                    <CardContent className="flex items-center gap-3 py-4 pr-12">
                      <AccountAvatar icon={acc.icon} type={acc.type} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-semibold">{acc.name}</span>
                          {paused && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                              Pausada
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {typeLabel[acc.type]}
                          {acc.type === "credit" && acc.defaultClosingDay
                            ? ` · cierre día ${acc.defaultClosingDay}`
                            : ""}
                          {children.length > 0
                            ? ` · ${children.length} ${children.length === 1 ? "tarjeta" : "tarjetas"}`
                            : ""}
                        </div>
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </CardContent>
                  </Card>
                </Link>
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                  {renderMenu(acc)}
                </div>
              </div>

              {children.length > 0 && (
                <div className="ml-5 space-y-2 border-l-2 border-border pl-3">
                  {children.map((card) => {
                    const cardPaused = card.active === false;
                    return (
                      <div key={card.id} className="relative">
                        <Link
                          href={`/cuentas/${card.id}`}
                          className={cardPaused ? "opacity-60" : ""}
                        >
                          <Card className="rounded-xl transition hover:shadow-sm active:scale-[0.99]">
                            <CardContent className="flex items-center gap-3 py-3 pr-10">
                              <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground">
                                <AccountIcon
                                  name={card.icon ?? defaultIconForType(card.type)}
                                  className="size-4"
                                />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-sm font-medium">
                                    {card.name}
                                  </span>
                                  {cardPaused && (
                                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                      Pausada
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  {typeLabel[card.type]}
                                  {card.defaultClosingDay
                                    ? ` · cierre día ${card.defaultClosingDay}`
                                    : ""}
                                </div>
                              </div>
                              <ChevronRight className="size-4 text-muted-foreground" />
                            </CardContent>
                          </Card>
                        </Link>
                        <div className="absolute right-1 top-1/2 -translate-y-1/2">
                          {renderMenu(card)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
