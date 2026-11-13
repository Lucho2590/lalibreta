"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  ClipboardCheck,
  CreditCard,
  FileText,
  Handshake,
  Home,
  LayoutGrid,
  List,
  LogOut,
  MessageCircle,
  Plus,
  Repeat,
  Tag,
  Users,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/firebase/auth";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useNewTransactionSheet } from "@/components/transactions/new-transaction-sheet";

const items = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/movimientos", label: "Movimientos", icon: List },
  { href: "/cuentas", label: "Cuentas", icon: CreditCard },
] as const;

/** Todo lo que en la compu está en la barra lateral y no entra abajo. */
const moreItems = [
  { href: "/ingresos", label: "Ingresos", icon: Wallet },
  { href: "/fijos", label: "Fijos", icon: Repeat },
  { href: "/compartidas", label: "Compartidas", icon: Handshake },
  { href: "/aprobaciones", label: "Aprobaciones", icon: ClipboardCheck },
  { href: "/contactos", label: "Contactos", icon: Users },
  { href: "/categorias", label: "Categorías", icon: Tag },
  { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { href: "/resumenes", label: "Importar resumen", icon: FileText, note: "desde la compu" },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const { open } = useNewTransactionSheet();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = moreItems.some((i) => pathname.startsWith(i.href));

  return (
    <>
      {/* Fija a la pantalla (no sticky): así no se va al scrollear. El <main>
          tiene padding abajo para que no tape el contenido. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 items-end border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
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
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex flex-col items-center justify-center gap-0.5 py-2 text-xs",
            moreActive ? "text-primary" : "text-muted-foreground",
          )}
        >
          <LayoutGrid className="size-5" />
          <span>Más</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-3xl pb-[calc(1rem+env(safe-area-inset-bottom))] md:hidden">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Más</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-2 px-4">
            {moreItems.map((item) => {
              const Icon = item.icon;
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-center text-xs font-medium transition",
                    active ? "bg-primary/10 text-primary" : "hover:bg-muted",
                  )}
                >
                  <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground">
                    <Icon className="size-5" />
                  </span>
                  {item.label}
                  {"note" in item && (
                    <span className="-mt-1 text-[10px] font-normal text-muted-foreground">{item.note}</span>
                  )}
                </Link>
              );
            })}
          </div>
          <div className="px-4">
            <button
              type="button"
              onClick={() => signOut()}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border py-3 text-sm text-muted-foreground hover:bg-muted"
            >
              <LogOut className="size-4" /> Cerrar sesión
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
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
