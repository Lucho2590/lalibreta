"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardCheck,
  CreditCard,
  Handshake,
  Home,
  List,
  LogOut,
  Plus,
  Repeat,
  Tag,
  Users,
  Wallet,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/firebase/auth";
import { useNewTransactionSheet } from "@/components/transactions/new-transaction-sheet";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/movimientos", label: "Movimientos", icon: List },
  { href: "/cuentas", label: "Cuentas", icon: CreditCard },
  { href: "/fijos", label: "Gastos fijos", icon: Repeat },
  { href: "/ingresos", label: "Ingresos", icon: Wallet },
  { href: "/compartidas", label: "Compartidas", icon: Handshake },
  { href: "/aprobaciones", label: "Aprobaciones", icon: ClipboardCheck },
  { href: "/contactos", label: "Contactos", icon: Users },
  { href: "/categorias", label: "Categorías", icon: Tag },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const { open } = useNewTransactionSheet();
  const initial = user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <aside className="hidden md:flex md:w-64 lg:w-72 shrink-0 sticky top-0 h-screen flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-2 border-b px-5">
        <div className="flex size-9 items-center justify-center rounded-xl bg-brand-grad text-white shadow-sm">
          <Wallet className="size-5" strokeWidth={2.25} />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-tight">Saldo</div>
          <div className="text-[11px] text-muted-foreground">Control de gastos</div>
        </div>
      </div>

      <div className="px-4 pt-4">
        <Button
          onClick={() => open()}
          className="w-full h-10 gap-2 rounded-xl bg-brand-grad text-white hover:opacity-95"
        >
          <Plus className="size-4" /> Nuevo movimiento
        </Button>
      </div>

      <nav className="mt-4 flex flex-1 flex-col gap-0.5 px-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-3">
        <div className="flex items-center gap-3 rounded-lg p-2">
          <Avatar className="size-9">
            {user?.photoURL && <AvatarImage src={user.photoURL} alt="" />}
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{user?.displayName ?? "Cuenta"}</div>
            <div className="truncate text-[11px] text-muted-foreground">{user?.email}</div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => signOut()}
            aria-label="Cerrar sesión"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
