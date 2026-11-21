"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Check, ChevronRight, Copy, Loader2, RotateCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { errorText } from "@/lib/api";
import { getCalendarFeed, resetCalendarFeed, type CalendarFeed } from "@/lib/agenda/calendar-feed-client";
import { googleCalendarSubscribeUrl, webcalUrl } from "@/lib/domain/ical";

/**
 * "Ver la agenda en tu calendario": link privado para suscribirse desde
 * Google Calendar, el iPhone/Mac u Outlook. Va en una sola dirección
 * (La Libreta → calendario).
 */
export function CalendarSyncSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [feed, setFeed] = useState<CalendarFeed | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || feed) return;
    getCalendarFeed()
      .then(setFeed)
      .catch((err) => toast.error(errorText(err)));
  }, [open, feed]);

  const copy = async () => {
    if (!feed) return;
    try {
      await navigator.clipboard.writeText(feed.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("No se pudo copiar: mantené apretado el link y copialo a mano");
    }
  };

  const reset = async () => {
    if (!confirm("¿Generar un link nuevo? El actual deja de funcionar y vas a tener que volver a agregarlo en tus calendarios.")) return;
    setBusy(true);
    try {
      setFeed(await resetCalendarFeed());
      toast.success("Listo: link nuevo");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>Ver la agenda en tu calendario</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 px-5 pb-6 pt-1 text-sm">
          <p className="text-muted-foreground">
            Agregá tu agenda de La Libreta a Google Calendar o al calendario del celular. Lo que agendes acá (o por
            WhatsApp) aparece solo allá.
          </p>

          {!feed ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Agregala a</div>
                <div className="grid gap-2">
                  <a
                    href={googleCalendarSubscribeUrl(feed.url)}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-center gap-3 rounded-2xl border p-3 transition hover:border-primary/40 hover:bg-primary/[0.04]"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-grad text-white">
                      <CalendarDays className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">Google Calendar</span>
                      <span className="block text-xs text-muted-foreground">Android, la compu y la app de Google</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                  </a>
                  <a
                    href={webcalUrl(feed.url)}
                    className="group flex items-center gap-3 rounded-2xl border p-3 transition hover:border-primary/40 hover:bg-primary/[0.04]"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                      <Smartphone className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">iPhone o Mac</span>
                      <span className="block text-xs text-muted-foreground">Calendario de Apple</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                  </a>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">O copiá el link y agregalo a mano</div>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={feed.url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 rounded-xl border bg-muted/40 px-3 py-2 font-mono text-xs"
                    aria-label="Link del calendario"
                  />
                  <Button variant="outline" className="shrink-0 rounded-xl" onClick={copy}>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copied ? "Copiado" : "Copiar"}
                  </Button>
                </div>
              </div>

              <details className="rounded-xl bg-muted/50 p-3">
                <summary className="cursor-pointer font-medium">Cómo agregarlo a mano</summary>
                <div className="mt-2 space-y-2 text-muted-foreground">
                  <p>
                    <b className="text-foreground">Google Calendar (en la compu):</b> a la izquierda, en “Otros
                    calendarios”, tocá <b>+</b> → <b>Desde URL</b>, pegá el link y <b>Agregar calendario</b>. Después
                    aparece también en la app de Google Calendar del celular.
                  </p>
                  <p>
                    <b className="text-foreground">iPhone:</b> Ajustes → Calendario → Cuentas → Agregar cuenta → Otra →{" "}
                    <b>Agregar calendario suscrito</b>, pegá el link y guardá.
                  </p>
                  <p>
                    <b className="text-foreground">Outlook:</b> Agregar calendario → Suscribirse desde la web.
                  </p>
                </div>
              </details>

              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>Va en una sola dirección: lo que cambies en el otro calendario no vuelve a La Libreta.</li>
                <li>
                  Los cambios no llegan al instante: el iPhone actualiza cada cierto tiempo (se puede elegir) y Google
                  cada varias horas.
                </li>
                <li>El link es privado: no lo compartas. Si lo compartiste, generá uno nuevo.</li>
              </ul>

              <Button variant="ghost" size="sm" className="-ml-2 rounded-xl text-muted-foreground" onClick={reset} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                Generar un link nuevo
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
