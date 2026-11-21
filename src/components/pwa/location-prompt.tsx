"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts } from "@/hooks/use-data";
import {
  fetchSavedLocation,
  geoPermission,
  isPermissionDenied,
  placeLabel,
  pushLocation,
  watchGeoPermission,
  type GeoPermission,
} from "@/lib/pwa/location-client";

/**
 * Ubicación para el clima y las alertas del SMN.
 *
 * Cada vez que se abre la app:
 * - Si ya hay una ubicación guardada, no pregunta nada: si el permiso está
 *   dado la actualiza en silencio (el server solo escribe si se movió más de
 *   1 km o pasaron 6 h).
 * - Si nunca la activó, muestra un cartel pidiendo activarla, hasta que la active.
 *   "Ahora no" lo oculta solo hasta que se cierre la app.
 * - Si el permiso está bloqueado, explica cómo habilitarlo a mano.
 * - Si el usuario eligió "Dejar de usar mi ubicación" (en /clima), no molesta.
 * No aparece hasta que terminó de armar sus cuentas (para no tapar el alta).
 */

const DISMISS_KEY = "location-prompt-dismissed";

type Phase = "hidden" | "ask" | "denied";

const platform = () => {
  if (typeof navigator === "undefined") return "other" as const;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios" as const;
  if (/Android/.test(ua)) return "android" as const;
  return "other" as const;
};

function DeniedHelp() {
  const p = platform();
  if (p === "ios") {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>
          Abrí <b>Ajustes</b> → <b>Privacidad y seguridad</b> → <b>Localización</b> y fijate que esté activada.
        </li>
        <li>
          Más abajo, en <b>Safari</b> (o en <b>La Libreta</b> si la instalaste), elegí <b>Preguntar</b> o{" "}
          <b>Mientras se usa</b>.
        </li>
        <li>Volvé a la app y tocá “Ya lo activé”.</li>
      </ol>
    );
  }
  if (p === "android") {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>
          En Chrome, tocá el ícono a la izquierda de la dirección (o ⋮ → <b>Información del sitio</b>).
        </li>
        <li>
          <b>Permisos</b> → <b>Ubicación</b> → <b>Permitir</b>.
        </li>
        <li>Si la instalaste: mantené apretado el ícono → Información de la app → Permisos → Ubicación.</li>
      </ol>
    );
  }
  return (
    <p className="text-sm">
      Tocá el ícono a la izquierda de la dirección del navegador → <b>Ubicación</b> → <b>Permitir</b>, y después “Ya lo
      activé”.
    </p>
  );
}

export function LocationPrompt() {
  const { user } = useAuth();
  const { data: accounts, loading: accountsLoading } = useAccounts();
  const [phase, setPhase] = useState<Phase>("hidden");
  const [busy, setBusy] = useState(false);
  const checked = useRef(false);

  const setupDone = !accountsLoading && accounts.some((a) => a.isMain && a.active !== false);

  const show = useCallback((next: Exclude<Phase, "hidden">) => {
    if (window.sessionStorage.getItem(DISMISS_KEY) === "1") return;
    setPhase(next);
  }, []);

  // Una vez por apertura de la app.
  useEffect(() => {
    if (!user || !setupDone || checked.current) return;
    checked.current = true;
    void (async () => {
      const perm: GeoPermission = await geoPermission();
      if (perm === "unsupported") return;
      let saved: Awaited<ReturnType<typeof fetchSavedLocation>>;
      try {
        saved = await fetchSavedLocation();
      } catch {
        return;
      }
      if (saved.optOut) return;

      // Ya tiene ubicación guardada: no se le vuelve a preguntar nunca. En el
      // celular (sobre todo iPhone) el navegador olvida el permiso entre
      // aperturas y dice "prompt" aunque ya lo haya aceptado; pedirle la
      // posición ahí le mostraría el cartel del sistema cada vez. Solo se
      // actualiza en silencio si el permiso está dado de verdad.
      if (saved.location) {
        if (perm === "granted") await pushLocation(false).catch(() => {});
        return;
      }

      // Nunca la activó: se le pide (hasta que la active o elija no usarla).
      if (perm === "denied") return show("denied");
      if (perm === "granted") {
        try {
          await pushLocation(false);
          return;
        } catch (err) {
          return show(isPermissionDenied(err) ? "denied" : "ask");
        }
      }
      show("ask");
    })();
  }, [user, setupDone, show]);

  // Si lo habilita desde el navegador con el cartel abierto, se cierra solo.
  useEffect(() => {
    if (phase === "hidden") return;
    return watchGeoPermission((state) => {
      if (state === "granted") {
        void pushLocation(true).then(() => setPhase("hidden"), () => {});
      }
    });
  }, [phase]);

  const activate = async () => {
    setBusy(true);
    try {
      const res = await pushLocation(true);
      setPhase("hidden");
      toast.success(`📍 Listo: ${res.location ? placeLabel(res.location) : "ubicación activada"}`, {
        description: "Te vamos a avisar si hay alertas del clima en tu zona.",
      });
    } catch (err) {
      if (isPermissionDenied(err)) setPhase("denied");
      else toast.error("No pude obtener tu ubicación. Probá de nuevo en un ratito.");
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
    setPhase("hidden");
  };

  return (
    <Dialog open={phase !== "hidden"} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader className="items-center text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-grad text-white">
            <MapPin className="size-6" />
          </span>
          <DialogTitle className="text-lg font-bold">
            {phase === "denied" ? "La ubicación está bloqueada" : "Activá tu ubicación"}
          </DialogTitle>
          <DialogDescription>
            {phase === "denied"
              ? "Para avisarte de alertas del clima en tu zona necesitamos tu ubicación. El navegador la tiene bloqueada para La Libreta:"
              : "Así te avisamos si hay alertas del SMN (tormentas, viento, calor extremo) donde estás y te mostramos el clima del día. Usamos tu ubicación aproximada y solo para esto."}
          </DialogDescription>
        </DialogHeader>
        {phase === "denied" && <DeniedHelp />}
        <DialogFooter>
          <Button variant="ghost" onClick={dismiss} disabled={busy}>
            Ahora no
          </Button>
          <Button onClick={activate} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {phase === "denied" ? "Ya lo activé" : "Activar ubicación"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
