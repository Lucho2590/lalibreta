"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, Home, List, Plus, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNewTransactionSheet } from "@/components/transactions/new-transaction-sheet";

const items = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/movimientos", label: "Movimientos", icon: List },
  { href: "/cuentas", label: "Cuentas", icon: CreditCard },
  { href: "/ingresos", label: "Ingresos", icon: Wallet },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const { open } = useNewTransactionSheet();

  return (
    <nav className="sticky bottom-0 z-30 grid grid-cols-5 items-end border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {items.slice(0, 2).map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} />
      ))}
      <div className="relative flex items-end justify-center">
        <button
          type="button"
          onClick={() => open()}
          aria-label="Nuevo gasto"
          className="-translate-y-3 rounded-full bg-brand-grad text-white shadow-lg ring-4 ring-background flex h-14 w-14 items-center justify-center"
        >
          <Plus className="size-6" />
        </button>
      </div>
      {items.slice(2).map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} />
      ))}
    </nav>
  );
}

function NavLink({
  item,
  pathname,
}: {
  item: { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
  pathname: string;
}) {
  const Icon = item.icon;
  const active =
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      className={cn(
        "flex flex-col items-center justify-center gap-0.5 py-2 text-xs",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5" />
      <span>{item.label}</span>
    </Link>
  );
}
