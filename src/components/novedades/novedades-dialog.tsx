"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  CalendarDays,
  ChevronLeft,
  CloudSun,
  Coins,
  Handshake,
  LayoutGrid,
  ListChecks,
  MessageCircle,
  Pencil,
  PiggyBank,
  Sparkles,
  Users,
  Watch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts } from "@/hooks/use-data";
import { db } from "@/lib/firebase/client";
import { cn } from "@/lib/utils";
import {
  LATEST_NOVEDAD,
  NOVEDADES,
  arDate,
  pendingNovedades,
  type Novedad,
  type NovedadIcon,
} from "@/lib/domain/novedades";

const ICONS: Record<NovedadIcon, React.ComponentType<{ className?: string }>> = {
  vaquitas: PiggyBank,
  listas: ListChecks,
  contactos: Users,
  inicio: LayoutGrid,
  monedas: Coins,
  agenda: CalendarDays,
  clima: CloudSun,
  reloj: Watch,
  editar: Pencil,
  gente: Handshake,
};

// ---------------------------------------------------------------------------
// Estado compartido: el menú puede abrir las novedades, y el cartel de la
// ubicación espera a que se cierren para no aparecer encima.

type Phase = "checking" | "open" | "done";
let phase: Phase = "checking";
let items: Novedad[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const setPhase = (next: Phase, nextItems: Novedad[] = items) => {
  phase = next;
  items = nextItems;
  emit();
};

/** Abre las novedades (desde el menú: todas). */
export const openNovedades = (list: Novedad[] = NOVEDADES) => setPhase("open", list);

/** "done" cuando ya no hay novedades para mostrar al abrir la app. */
export const useNovedadesPhase = () => useSyncExternalStore(subscribe, () => phase, () => "checking" as Phase);

// ---------------------------------------------------------------------------

/**
 * Al abrir la app, muestra lo nuevo desde la última vez (una vez por novedad,
 * en todos los dispositivos). No aparece hasta que terminó de armar sus
 * cuentas, para no tapar el alta.
 */
export function NovedadesDialog() {
  const { user } = useAuth();
  const { data: accounts, loading: accountsLoading } = useAccounts();
  const current = useSyncExternalStore(subscribe, () => phase, () => "checking" as Phase);
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  const [index, setIndex] = useState(0);
  const checked = useRef(false);
  const nextRef = useRef<HTMLButtonElement>(null);

  const setupDone = !accountsLoading && accounts.some((a) => a.isMain && a.active !== false);

  useEffect(() => {
    if (!user || !setupDone || checked.current) return;
    checked.current = true;
    void (async () => {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const seen = snap.data()?.novedadesSeen as string | undefined;
        const created = user.metadata.creationTime ? arDate(new Date(user.metadata.creationTime)) : null;
        const pending = pendingNovedades(seen, created);
        if (phase !== "checking") return; // ya la abrió desde el menú
        if (pending.length > 0) setPhase("open", pending);
        else setPhase("done");
      } catch {
        setPhase("done");
      }
    })();
  }, [user, setupDone]);

  // Cada vez que se abre, desde la primera.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- volver al principio al reabrir
    if (current === "open") setIndex(0);
  }, [current]);

  const close = () => {
    setPhase("done");
    if (user) {
      void setDoc(doc(db, "users", user.uid), { novedadesSeen: LATEST_NOVEDAD }, { merge: true }).catch(() => {});
    }
  };

  const item = list[Math.min(index, list.length - 1)];
  if (!item) return null;
  const Icon = ICONS[item.icon] ?? Sparkles;
  const last = index >= list.length - 1;

  return (
    <Dialog open={current === "open"} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false} initialFocus={nextRef} className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="bg-brand-grad px-6 pb-6 pt-5 text-white">
          <div className="flex items-center justify-between text-xs font-medium opacity-90">
            <span className="flex items-center gap-1.5">
              <Sparkles className="size-3.5" /> Novedades en La Libreta
            </span>
            {list.length > 1 && (
              <span>
                {index + 1} de {list.length}
              </span>
            )}
          </div>
          <div key={item.id} className="mt-4 flex items-center gap-3 animate-in fade-in-0 slide-in-from-right-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/20">
              <Icon className="size-6" />
            </span>
            <DialogTitle className="text-xl font-bold leading-tight text-white">{item.title}</DialogTitle>
          </div>
        </div>

        <div key={`b-${item.id}`} className="space-y-3 px-6 py-5 animate-in fade-in-0">
          <DialogDescription className="text-sm leading-relaxed text-foreground">{item.body}</DialogDescription>
          {item.whatsapp && (
            <div className="flex items-start gap-2 rounded-xl bg-muted/70 p-3 text-sm">
              <MessageCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="text-muted-foreground">Por WhatsApp: </span>«{item.whatsapp}»
              </span>
            </div>
          )}
          {item.href && (
            <Button
              variant="outline"
              className="w-full rounded-xl"
              render={<Link href={item.href} onClick={close} />}
              nativeButton={false}
            >
              {item.cta ?? "Ver"}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-3">
          {index > 0 ? (
            <Button variant="ghost" size="icon" aria-label="Anterior" onClick={() => setIndex((i) => i - 1)}>
              <ChevronLeft className="size-4" />
            </Button>
          ) : (
            <Button variant="ghost" onClick={close} className="text-muted-foreground">
              Cerrar
            </Button>
          )}
          {list.length > 1 && (
            <div className="flex flex-1 justify-center gap-1.5">
              {list.map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  aria-label={`Ir a ${n.title}`}
                  onClick={() => setIndex(i)}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === index ? "w-4 bg-brand" : "w-1.5 bg-muted-foreground/30",
                  )}
                />
              ))}
            </div>
          )}
          <Button
            ref={nextRef}
            className={cn("rounded-xl bg-brand-grad text-white hover:opacity-95", list.length <= 1 && "ml-auto")}
            onClick={() => (last ? close() : setIndex((i) => i + 1))}
          >
            {last ? "¡Listo!" : "Siguiente"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
