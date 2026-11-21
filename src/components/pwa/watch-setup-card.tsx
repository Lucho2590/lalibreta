"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { MessageCircle, Watch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { db } from "@/lib/firebase/client";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { withDefaultPrefs } from "@/lib/domain/notifications";
import { WATCH_SETUP_GUIDES, watchGuide, type WatchSetupId } from "@/lib/domain/watch-setup";

const STORAGE_KEY = "watch-setup-device";

/** Cómo ver los avisos en el reloj, según la marca y el celular. */
export function WatchSetupCard() {
  const { user } = useAuth();
  const [device, setDevice] = useState<WatchSetupId | null>(null);
  const [copy, setCopy] = useState<boolean | null>(null);
  const [waLinked, setWaLinked] = useState<boolean | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage solo existe en el cliente
    if (WATCH_SETUP_GUIDES.some((g) => g.id === saved)) setDevice(saved as WatchSetupId);
  }, []);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) =>
      setCopy(withDefaultPrefs(snap.data()?.notificationPrefs).whatsappCopy),
    );
  }, [user]);

  useEffect(() => {
    if (!user) return;
    apiJson<{ linked: boolean }>("/api/whatsapp/status")
      .then((s) => setWaLinked(s.linked))
      .catch(() => setWaLinked(null));
  }, [user]);

  const choose = (id: WatchSetupId) => {
    setDevice(id);
    localStorage.setItem(STORAGE_KEY, id);
  };

  const saveCopy = async (on: boolean) => {
    if (!user) return;
    setCopy(on);
    try {
      await setDoc(doc(db, "users", user.uid), { notificationPrefs: { whatsappCopy: on } }, { merge: true });
      if (on) toast("Listo: cada aviso te va a llegar también por WhatsApp");
    } catch {
      toast.error("No se pudo guardar");
    }
  };

  const guide = device ? watchGuide(device) : null;

  return (
    <Card className="rounded-3xl">
      <CardContent className="space-y-4 py-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Watch className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="font-semibold">Avisos en el reloj</div>
            <div className="text-sm text-muted-foreground">
              El reloj muestra lo que le llega al celular. ¿Cuál tenés?
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {WATCH_SETUP_GUIDES.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => choose(g.id)}
              className={cn(
                "rounded-xl border px-3 py-2 text-left transition-colors",
                device === g.id ? "border-brand bg-brand/10" : "hover:bg-muted/60",
              )}
            >
              <div className="text-sm font-medium">{g.label}</div>
              <div className="text-xs text-muted-foreground">{g.examples}</div>
            </button>
          ))}
        </div>

        {guide?.note && <p className="text-sm text-muted-foreground">{guide.note}</p>}

        {guide && (
          <ol className="list-decimal space-y-1.5 rounded-xl bg-muted/60 py-3 pl-8 pr-3 text-sm">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}

        <div
          className={cn(
            "flex flex-wrap items-center gap-3 rounded-xl border p-3",
            guide?.needsWhatsappCopy && !copy && "border-brand",
          )}
        >
          <MessageCircle className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Copia por WhatsApp</div>
            <div className="text-xs text-muted-foreground">
              Cada aviso te llega también por WhatsApp. Sirve si tu reloj muestra los de WhatsApp pero no los de La
              Libreta.
            </div>
          </div>
          {waLinked === false ? (
            <Button size="sm" variant="outline" className="rounded-lg" render={<Link href="/whatsapp" />} nativeButton={false}>
              Vincular WhatsApp
            </Button>
          ) : (
            <Switch
              checked={!!copy}
              disabled={copy === null}
              onCheckedChange={saveCopy}
              aria-label="Copia por WhatsApp"
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          ¿Te trabás? Preguntale a tu agente por WhatsApp «¿cómo hago para que me lleguen los avisos al reloj?».
        </p>
      </CardContent>
    </Card>
  );
}
