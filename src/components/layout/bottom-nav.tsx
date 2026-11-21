"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LayoutGrid, LogOut, Plus } from "lucide-react";
import { rectSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/firebase/auth";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useNewTransactionSheet } from "@/components/transactions/new-transaction-sheet";
import { useNavOrder } from "@/hooks/use-nav-order";
import {
  BOTTOM_BAR_HREFS,
  NAV_ITEMS,
  isNavActive,
  mergeSubsetOrder,
  type NavItem,
} from "@/components/layout/nav-items";
import { SortableNav, useSortableNavItem } from "@/components/layout/sortable-nav";

/** Fijas en la barra de abajo (no se reordenan). */
const barItems = NAV_ITEMS.filter((i) => BOTTOM_BAR_HREFS.includes(i.href));

export function BottomNav() {
  const pathname = usePathname();
  const { open } = useNewTransactionSheet();
  const [moreOpen, setMoreOpen] = useState(false);
  const { items, saveOrder } = useNavOrder();
  // Todo lo que en la compu está en la barra lateral y no entra abajo, en el orden del usuario.
  const moreItems = items.filter((i) => !BOTTOM_BAR_HREFS.includes(i.href));
  const moreActive = moreItems.some((i) => isNavActive(i.href, pathname));

  const reorderMore = (subset: string[]) =>
    saveOrder(mergeSubsetOrder(items.map((i) => i.href), subset));

  return (
    <>
      {/* Fija a la pantalla (no sticky): así no se va al scrollear. El <main>
          tiene padding abajo para que no tape el contenido. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 items-end border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {barItems.slice(0, 2).map((item) => (
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
        {barItems.slice(2).map((item) => (
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
            <SheetDescription className="text-xs">Mantené apretado un ícono para moverlo</SheetDescription>
          </SheetHeader>
          <FadeScroll>
            <div className="grid auto-rows-[var(--more-row)] grid-cols-3 gap-[var(--more-gap)] px-4">
              <SortableNav
                ids={moreItems.map((i) => i.href)}
                onReorder={reorderMore}
                strategy={rectSortingStrategy}
                renderOverlay={(id) => {
                  const item = moreItems.find((i) => i.href === id);
                  return item ? <MoreTile item={item} active={isNavActive(item.href, pathname)} overlay /> : null;
                }}
              >
                {moreItems.map((item) => (
                  <SortableMoreLink
                    key={item.href}
                    item={item}
                    active={isNavActive(item.href, pathname)}
                    onNavigate={() => setMoreOpen(false)}
                  />
                ))}
              </SortableNav>
            </div>
          </FadeScroll>
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

/**
 * Contenedor con 3 filas completas a la vista. Si hay más, la siguiente
 * asoma abajo difuminada (blur + fundido) y se llega scrolleando.
 */
function FadeScroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [update]);

  return (
    <div className="relative [--more-gap:0.5rem] [--more-peek:3.5rem] [--more-row:6.75rem]">
      <div
        ref={ref}
        onScroll={update}
        className="max-h-[calc(3*var(--more-row)+3*var(--more-gap)+var(--more-peek))] overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <EdgeBlur side="top" visible={edges.top} />
      <EdgeBlur side="bottom" visible={edges.bottom} />
    </div>
  );
}

/** Blur progresivo (más fuerte en el borde) + fundido al color de la hoja. */
function EdgeBlur({ side, visible }: { side: "top" | "bottom"; visible: boolean }) {
  const toEdge = side === "bottom" ? "to bottom" : "to top";
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 transition-opacity duration-200",
        side === "bottom" ? "bottom-0 h-[calc(var(--more-peek)+0.75rem)]" : "top-0 h-8",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className="absolute inset-0 backdrop-blur-[1px]"
        style={{ maskImage: `linear-gradient(${toEdge}, transparent, black 60%)` }}
      />
      <div
        className="absolute inset-0 backdrop-blur-[3px]"
        style={{ maskImage: `linear-gradient(${toEdge}, transparent 40%, black)` }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(${toEdge}, transparent, color-mix(in oklab, var(--popover) 75%, transparent))`,
        }}
      />
    </div>
  );
}

function SortableMoreLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  const { itemProps, isDragging } = useSortableNavItem(item.href);
  return (
    <Link
      href={item.href}
      {...itemProps}
      onClick={onNavigate}
      className={cn(
        "block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-35",
      )}
    >
      <MoreTile item={item} active={active} />
    </Link>
  );
}

/** Ícono + nombre de la grilla "Más" (también es la copia que se arrastra). */
function MoreTile({ item, active, overlay }: { item: NavItem; active: boolean; overlay?: boolean }) {
  const Icon = item.icon;
  return (
    <div
      className={cn(
        "flex h-full select-none flex-col items-center justify-center gap-1.5 rounded-2xl px-2 py-2 text-center text-xs font-medium transition [-webkit-touch-callout:none]",
        active ? "bg-primary/10 text-primary" : "hover:bg-muted",
        overlay && "scale-105 cursor-grabbing bg-popover shadow-xl ring-1 ring-black/5",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
        <Icon className="size-5" />
      </span>
      {item.mobileLabel ?? item.label}
      {item.note && <span className="-mt-1 text-[10px] font-normal text-muted-foreground">{item.note}</span>}
    </div>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex flex-col items-center justify-center gap-0.5 py-2 text-xs",
        isNavActive(item.href, pathname) ? "text-primary" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5" />
      <span>{item.label}</span>
    </Link>
  );
}
