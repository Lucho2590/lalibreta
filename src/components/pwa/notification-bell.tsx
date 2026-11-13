"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/hooks/use-data";

/** Campanita con la cantidad de avisos sin leer. Lleva a /notificaciones. */
export function NotificationBell({ className }: { className?: string }) {
  const pathname = usePathname();
  const { data } = useNotifications();
  const unread = data.filter((n) => !n.read).length;

  // Con la app instalada, el número también aparece sobre el ícono.
  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (unread > 0) nav.setAppBadge?.(unread).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [unread]);

  const active = pathname.startsWith("/notificaciones");
  return (
    <Link
      href="/notificaciones"
      aria-label={unread > 0 ? `Notificaciones (${unread} sin leer)` : "Notificaciones"}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-xl transition hover:bg-muted",
        active ? "text-primary" : "text-muted-foreground",
        className,
      )}
    >
      <Bell className="size-5" />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none ring-2 ring-background">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}
