"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GripVertical, LogOut, Plus, Wallet } from "lucide-react";
import { verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/firebase/auth";
import { useNewTransactionSheet } from "@/components/transactions/new-transaction-sheet";
import { cn } from "@/lib/utils";
import { AdminLogoTap } from "@/components/admin/admin-logo-tap";
import { useNavOrder } from "@/hooks/use-nav-order";
import { isNavActive, type NavItem } from "@/components/layout/nav-items";
import { SortableNav, useSortableNavItem } from "@/components/layout/sortable-nav";

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const { open } = useNewTransactionSheet();
  const initial = user?.email?.[0]?.toUpperCase() ?? "?";
  const { items, saveOrder } = useNavOrder();
  const ids = items.map((i) => i.href);

  return (
    <aside className="hidden md:flex md:w-64 lg:w-72 shrink-0 sticky top-0 h-screen flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-2 border-b px-5">
        <AdminLogoTap>
          <div className="flex size-9 items-center justify-center rounded-xl bg-brand-grad text-white shadow-sm">
            <Wallet className="size-5" strokeWidth={2.25} />
          </div>
        </AdminLogoTap>
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-tight">La Libreta</div>
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

      <nav className="mt-4 flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        <SortableNav
          ids={ids}
          onReorder={saveOrder}
          strategy={verticalListSortingStrategy}
          renderOverlay={(id) => {
            const item = items.find((i) => i.href === id);
            return item ? <SidebarRow item={item} active={isNavActive(item.href, pathname)} overlay /> : null;
          }}
        >
          {items.map((item) => (
            <SortableSidebarLink key={item.href} item={item} active={isNavActive(item.href, pathname)} />
          ))}
        </SortableNav>
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

function SortableSidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  const { itemProps, isDragging } = useSortableNavItem(item.href);
  return (
    <Link
      href={item.href}
      {...itemProps}
      className={cn(
        "block select-none rounded-lg outline-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-35",
      )}
    >
      <SidebarRow item={item} active={active} />
    </Link>
  );
}

/** Contenido de una fila del menú (también se usa para la copia que se arrastra). */
function SidebarRow({ item, active, overlay }: { item: NavItem; active: boolean; overlay?: boolean }) {
  const Icon = item.icon;
  return (
    <div
      className={cn(
        "group flex select-none items-center gap-3 rounded-lg px-3 py-2 text-sm transition [-webkit-touch-callout:none]",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        overlay && "cursor-grabbing bg-sidebar text-foreground shadow-xl ring-1 ring-black/5",
      )}
    >
      <Icon className="size-4" />
      <span className="flex-1 truncate">{item.label}</span>
      <GripVertical
        aria-hidden
        className={cn(
          "size-3.5 text-muted-foreground/70 transition-opacity",
          overlay ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      />
    </div>
  );
}
