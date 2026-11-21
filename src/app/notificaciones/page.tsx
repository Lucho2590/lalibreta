"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import {
  Check,
  ListChecks,
  Minus,
  Settings2,
  Trash2,
  X,
  BellOff,
  BellRing,
  CalendarClock,
  CalendarDays,
  CalendarX,
  CheckCheck,
  CloudLightning,
  CloudSun,
  CreditCard,
  Download,
  Handshake,
  HandCoins,
  Inbox,
  Loader2,
  Repeat,
  Share,
  SquarePlus,
  Sparkles,
  UserPlus,
  Users,
  ArrowLeftRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useNotifications } from "@/hooks/use-data";
import { db } from "@/lib/firebase/client";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  canPromptInstall,
  disablePush,
  enablePush,
  getCurrentSubscription,
  isIOS,
  isStandalone,
  onInstallAvailabilityChange,
  promptInstall,
  pushSupported,
} from "@/lib/pwa/push-client";
import {
  withDefaultPrefs,
  type AppNotification,
  type NotificationKind,
  type NotificationPrefs,
} from "@/lib/domain/notifications";

export default function NotificacionesPage() {
  const { data } = useNotifications();
  const unread = data.filter((n) => !n.read).length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Notificaciones</h1>
        <p className="text-sm text-muted-foreground">
          Vencimientos, fijos, el clima y lo que pasa en tus cuentas compartidas.
        </p>
      </div>

      <Tabs defaultValue="avisos">
        <TabsList className="grid w-full grid-cols-2 sm:w-96">
          <TabsTrigger value="avisos">
            <BellRing /> Avisos
            {unread > 0 && (
              <span className="rounded-full bg-brand px-1.5 py-px text-[10px] font-bold leading-4 text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings2 /> Configuración
          </TabsTrigger>
        </TabsList>
        <TabsContent value="avisos" className="pt-4">
          <InboxList />
        </TabsContent>
        <TabsContent value="config" className="space-y-4 pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <DeviceCard />
            <InstallCard />
          </div>
          <h2 className="pt-2 text-sm font-semibold text-muted-foreground">Qué querés que te avisemos</h2>
          <PrefsCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Casilla de selección (es un dibujo: el click lo maneja la fila). */
function CheckMark({ state }: { state: "on" | "off" | "some" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md border transition",
        state === "off" ? "border-muted-foreground/40 bg-background" : "border-primary bg-primary text-primary-foreground",
      )}
    >
      {state === "on" && <Check className="size-3.5" strokeWidth={3} />}
      {state === "some" && <Minus className="size-3.5" strokeWidth={3} />}
    </span>
  );
}

function InboxList() {
  const { data, loading } = useNotifications();
  const { user } = useAuth();
  const router = useRouter();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Si un aviso seleccionado desaparece (se borró en otro dispositivo), sale de la selección.
  const ids = new Set(data.map((n) => n.id));
  const chosen = data.filter((n) => selected.has(n.id));
  const unread = data.filter((n) => !n.read);
  const allState = chosen.length === 0 ? "off" : chosen.length === data.length ? "on" : "some";

  const notifRef = (id: string) => doc(db, `users/${user!.uid}/notifications/${id}`);
  const dismissedRef = (id: string) => doc(db, `users/${user!.uid}/dismissedNotifications/${id}`);

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set([...prev].filter((x) => ids.has(x)));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => setSelected(allState === "on" ? new Set() : new Set(data.map((n) => n.id)));

  const markRead = async (list: AppNotification[]) => {
    const pending = list.filter((n) => !n.read);
    if (!user || pending.length === 0) return;
    const batch = writeBatch(db);
    for (const n of pending) batch.update(notifRef(n.id), { read: true });
    await batch.commit().catch(() => toast.error("No se pudo completar"));
  };

  /** Vuelve a dejar los avisos como estaban (botón "Deshacer"). */
  const restore = async (list: AppNotification[]) => {
    if (!user) return;
    const batch = writeBatch(db);
    for (const n of list) {
      batch.set(notifRef(n.id), {
        kind: n.kind,
        title: n.title,
        body: n.body,
        url: n.url,
        read: n.read,
        createdAt: n.createdAt ?? serverTimestamp(),
      });
      batch.delete(dismissedRef(n.id));
    }
    await batch.commit().catch(() => toast.error("No se pudieron recuperar"));
  };

  /**
   * Borra los avisos. Queda una marca en dismissedNotifications para que los
   * que no se repiten (un vencimiento, una alerta del clima) no vuelvan a llegar.
   */
  const remove = async (list: AppNotification[]) => {
    if (!user || list.length === 0) return;
    // Un batch admite 500 operaciones: 2 por aviso.
    for (let i = 0; i < list.length; i += 200) {
      const batch = writeBatch(db);
      for (const n of list.slice(i, i + 200)) {
        batch.delete(notifRef(n.id));
        batch.set(dismissedRef(n.id), { deletedAt: serverTimestamp() });
      }
      try {
        await batch.commit();
      } catch {
        toast.error("No se pudieron borrar");
        return;
      }
    }
    setSelected((prev) => new Set([...prev].filter((id) => !list.some((n) => n.id === id))));
    toast(list.length === 1 ? "Aviso borrado" : `Borraste ${list.length} avisos`, {
      action: { label: "Deshacer", onClick: () => void restore(list) },
    });
  };

  const open = (n: AppNotification) => {
    if (user && !n.read) void updateDoc(notifRef(n.id), { read: true }).catch(() => {});
    if (n.url && n.url !== "/notificaciones") router.push(n.url);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <Card className="rounded-3xl">
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
          <Inbox className="size-8 opacity-40" />
          No tenés avisos. Te vamos a avisar acá cuando se acerque un vencimiento, haya una alerta del clima o
          alguien cargue algo en una cuenta tuya.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Barra de acciones */}
      {selecting ? (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-2xl border bg-background/95 p-2 shadow-sm backdrop-blur md:top-[4.5rem]">
          <button
            type="button"
            onClick={toggleAll}
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <CheckMark state={allState} />
            {chosen.length === 0 ? "Elegir todas" : `${chosen.length} elegida${chosen.length === 1 ? "" : "s"}`}
          </button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-xl"
              disabled={!chosen.some((n) => !n.read)}
              onClick={() => void markRead(chosen)}
            >
              <CheckCheck className="size-4" /> <span className="hidden sm:inline">Marcar leídas</span>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="rounded-xl"
              disabled={chosen.length === 0}
              onClick={() => void remove(chosen)}
            >
              <Trash2 className="size-4" /> Borrar{chosen.length > 0 && ` (${chosen.length})`}
            </Button>
            <Button variant="ghost" size="icon-sm" className="rounded-xl" onClick={exitSelection} aria-label="Cancelar">
              <X className="size-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {unread.length > 0 ? `${unread.length} sin leer` : "Todo leído"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {unread.length > 0 && (
              <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => void markRead(unread)}>
                <CheckCheck className="size-4" /> Marcar todas como leídas
              </Button>
            )}
            <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setSelecting(true)}>
              <ListChecks className="size-4" /> Seleccionar
            </Button>
          </div>
        </div>
      )}

      <Card className="overflow-hidden rounded-3xl py-0">
        <ul className="divide-y">
          {data.map((n) => {
            const isSelected = selected.has(n.id);
            const content = (
              <>
                {selecting ? (
                  <span className="flex size-9 shrink-0 items-center justify-center">
                    <CheckMark state={isSelected ? "on" : "off"} />
                  </span>
                ) : (
                  <KindIcon kind={n.kind} />
                )}
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm", !n.read ? "font-semibold" : "font-medium")}>{n.title}</span>
                  <span className="block text-sm text-muted-foreground">{n.body}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {n.createdAt ? timeAgo(n.createdAt.toDate()) : "recién"}
                  </span>
                </span>
                {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />}
              </>
            );
            return (
              <li
                key={n.id}
                className={cn(
                  "group relative flex items-start",
                  !n.read && "bg-brand/[0.04]",
                  isSelected && "bg-primary/[0.07]",
                )}
              >
                <button
                  type="button"
                  onClick={() => (selecting ? toggle(n.id) : open(n))}
                  aria-pressed={selecting ? isSelected : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-start gap-3 py-3.5 pl-4 text-left transition hover:bg-muted/50",
                    selecting ? "pr-4" : "pr-12",
                  )}
                >
                  {content}
                </button>
                {!selecting && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Borrar aviso"
                    onClick={() => void remove([n])}
                    className="absolute top-2.5 right-2 rounded-lg text-muted-foreground hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

type DeviceState = "loading" | "unsupported" | "ios-install" | "off" | "on" | "denied";

function DeviceCard() {
  const [state, setState] = useState<DeviceState>("loading");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!pushSupported()) {
      // En el iPhone el push solo existe con la app agregada a la pantalla de inicio.
      setState(isIOS() && !isStandalone() ? "ios-install" : "unsupported");
      return;
    }
    if (Notification.permission === "denied") return setState("denied");
    const sub = await getCurrentSubscription();
    setState(sub && Notification.permission === "granted" ? "on" : "off");
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- estado del navegador, solo existe en el cliente
    void refresh();
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const r = await enablePush();
      if (r === "granted") toast.success("Listo: este dispositivo va a recibir avisos");
      else if (r === "denied") toast.error("El navegador bloqueó las notificaciones");
      else if (r === "missing-key") toast.error("Faltan las claves de notificaciones en el servidor");
      else toast.error("Este navegador no soporta notificaciones");
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron activar las notificaciones");
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const disable = async () => {
    setBusy(true);
    await disablePush().catch(() => {});
    setBusy(false);
    void refresh();
    toast("Listo: este dispositivo ya no recibe avisos");
  };

  const test = async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/api/push/test", { method: "POST" });
      const data = (await res.json()) as { pushed?: number };
      if (!res.ok) throw new Error();
      if (!data.pushed) toast("Te dejé el aviso acá, pero no llegó a ningún dispositivo");
    } catch {
      toast.error("No se pudo mandar la prueba");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="rounded-3xl">
      <CardContent className="space-y-3 py-5">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-10 items-center justify-center rounded-xl",
              state === "on" ? "bg-brand-grad text-white" : "bg-muted",
            )}
          >
            {state === "on" ? <BellRing className="size-5" /> : <BellOff className="size-5" />}
          </span>
          <div className="min-w-0">
            <div className="font-semibold">Avisos en este dispositivo</div>
            <div className="text-sm text-muted-foreground">
              {
                {
                  loading: "Revisando…",
                  unsupported: "Este navegador no permite notificaciones.",
                  "ios-install": "En el iPhone primero hay que instalar la app.",
                  off: "Desactivados. Activalos para que te lleguen aunque no tengas la app abierta.",
                  on: "Activados. Te llegan aunque no tengas la app abierta.",
                  denied: "Bloqueados en el navegador.",
                }[state]
              }
            </div>
          </div>
        </div>

        {state === "off" && (
          <Button onClick={enable} disabled={busy} className="w-full rounded-xl bg-brand-grad text-white hover:opacity-95">
            {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <BellRing className="mr-1.5 size-4" />}
            Activar notificaciones
          </Button>
        )}
        {state === "on" && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={test} disabled={busy} className="flex-1 rounded-xl">
              <Sparkles className="mr-1.5 size-4" /> Mandar una prueba
            </Button>
            <Button variant="ghost" onClick={disable} disabled={busy} className="rounded-xl text-muted-foreground">
              Desactivar
            </Button>
          </div>
        )}
        {state === "denied" && (
          <p className="rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
            Para habilitarlas, tocá el candado al lado de la dirección (o Ajustes del sitio) y permití las
            notificaciones de La Libreta. Después volvé a esta pantalla.
          </p>
        )}
        {state === "ios-install" && (
          <p className="rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
            Seguí los pasos de &quot;Instalar la app&quot;, abrila desde el ícono y volvé acá para activar los avisos
            (iOS 16.4 o más nuevo).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const subscribeInstall = (cb: () => void) => onInstallAvailabilityChange(cb);

function InstallCard() {
  const canInstall = useSyncExternalStore(subscribeInstall, canPromptInstall, () => false);
  const [env, setEnv] = useState<{ standalone: boolean; ios: boolean; mac: boolean } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- datos del navegador, solo existen en el cliente
    setEnv({
      standalone: isStandalone(),
      ios: isIOS(),
      mac: /Macintosh/.test(navigator.userAgent) && !isIOS(),
    });
  }, []);

  if (!env) return null;

  return (
    <Card className="rounded-3xl">
      <CardContent className="space-y-3 py-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Download className="size-5" />
          </span>
          <div>
            <div className="font-semibold">Instalar la app</div>
            <div className="text-sm text-muted-foreground">
              {env.standalone
                ? "Ya la estás usando instalada. 🎉"
                : "Se abre en su propia ventana, con ícono, como una app más."}
            </div>
          </div>
        </div>

        {!env.standalone && canInstall && (
          <Button
            onClick={async () => {
              if (await promptInstall()) toast.success("¡Instalada!");
            }}
            className="w-full rounded-xl bg-brand-grad text-white hover:opacity-95"
          >
            <Download className="mr-1.5 size-4" /> Instalar La Libreta
          </Button>
        )}

        {!env.standalone && !canInstall && env.ios && (
          <ol className="space-y-1.5 rounded-xl bg-muted/60 p-3 text-sm">
            <li className="flex items-center gap-2">
              1. Abrila en <b>Safari</b> y tocá <Share className="size-4" /> <b>Compartir</b>.
            </li>
            <li className="flex items-center gap-2">
              2. Elegí <SquarePlus className="size-4" /> <b>Agregar a inicio</b>.
            </li>
            <li>3. Abrila desde el ícono nuevo.</li>
          </ol>
        )}

        {!env.standalone && !canInstall && !env.ios && (
          <p className="rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
            {env.mac
              ? "En Chrome o Edge: el ícono de instalar en la barra de direcciones. En Safari: Archivo → Agregar al Dock."
              : "En Chrome o Edge: el ícono de instalar en la barra de direcciones o el menú ⋮ → Instalar La Libreta."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function PrefsCard() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) =>
      setPrefs(withDefaultPrefs(snap.data()?.notificationPrefs)),
    );
  }, [user]);

  const save = async (patch: Partial<NotificationPrefs>) => {
    if (!user || !prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      await setDoc(doc(db, "users", user.uid), { notificationPrefs: next }, { merge: true });
    } catch {
      toast.error("No se pudo guardar");
    }
  };

  if (!prefs) return null;

  return (
    <Card className="rounded-3xl">
      <CardContent className="divide-y py-1">
        <PrefRow
          icon={CalendarClock}
          title="Vencimiento de tarjetas"
          detail="Cuánto te queda por pagar del resumen."
          checked={prefs.cardDue}
          onChange={(v) => save({ cardDue: v })}
        >
          {prefs.cardDue && (
            <Select
              value={String(prefs.cardDueDaysBefore)}
              onValueChange={(v) => save({ cardDueDaysBefore: Number(v ?? 1) })}
            >
              <SelectTrigger className="h-8 w-[150px] rounded-lg text-xs">
                <SelectValue items={DAYS_OPTIONS} />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {DAYS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </PrefRow>
        <PrefRow
          icon={CreditCard}
          title="Cierre de tarjetas"
          detail="El día que cierra el resumen."
          checked={prefs.cardClose}
          onChange={(v) => save({ cardClose: v })}
        />
        <PrefRow
          icon={Repeat}
          title="Fijos del día"
          detail="Sueldo, suscripciones y gastos fijos que tocan hoy."
          checked={prefs.recurring}
          onChange={(v) => save({ recurring: v })}
        />
        <PrefRow
          icon={CalendarDays}
          title="Agenda del día"
          detail="A la mañana, las actividades que tenés para hoy."
          checked={prefs.agenda}
          onChange={(v) => save({ agenda: v })}
        />
        <PrefRow
          icon={Handshake}
          title="Cuentas compartidas y gente"
          detail="Cuando alguien carga algo en una cuenta tuya, o responde un gasto o una transferencia que le mandaste."
          checked={prefs.shared}
          onChange={(v) => save({ shared: v })}
        />
        <PrefRow
          icon={HandCoins}
          title="Cobrarle a la gente sin la app"
          detail="Te recuerda quién te debe plata (gastos que le pagaste o préstamos)."
          checked={prefs.debts}
          onChange={(v) => save({ debts: v })}
        >
          {prefs.debts && (
            <Select
              value={String(prefs.debtsEveryDays)}
              onValueChange={(v) => save({ debtsEveryDays: Number(v ?? 7) })}
            >
              <SelectTrigger className="h-8 w-[150px] rounded-lg text-xs">
                <SelectValue items={DEBT_DAYS_OPTIONS} />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {DEBT_DAYS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </PrefRow>
        <PrefRow
          icon={Inbox}
          title="Cosas para responder"
          detail="Si alguien te mandó un gasto, una transferencia o una solicitud y no respondiste en 2 días."
          checked={prefs.pendingReminders}
          onChange={(v) => save({ pendingReminders: v })}
        />
        <PrefRow
          icon={CloudLightning}
          title="Alertas del clima"
          detail="Alertas meteorológicas del SMN (tormentas, viento, calor, nevadas) en tu zona. Necesita tu ubicación."
          checked={prefs.weatherAlerts}
          onChange={(v) => save({ weatherAlerts: v })}
        />
        <PrefRow
          icon={CloudSun}
          title="Clima del día"
          detail="A la mañana, el pronóstico de hoy donde estás."
          checked={prefs.weatherDaily}
          onChange={(v) => save({ weatherDaily: v })}
        />
      </CardContent>
    </Card>
  );
}

const DEBT_DAYS_OPTIONS = [
  { value: "7", label: "Cada semana" },
  { value: "14", label: "Cada 2 semanas" },
  { value: "30", label: "Cada mes" },
];

const DAYS_OPTIONS = [
  { value: "0", label: "El mismo día" },
  { value: "1", label: "1 día antes" },
  { value: "2", label: "2 días antes" },
  { value: "3", label: "3 días antes" },
  { value: "5", label: "5 días antes" },
];

function PrefRow({
  icon: Icon,
  title,
  detail,
  checked,
  onChange,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-3.5">
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      {children}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </div>
  );
}

const KIND_ICON: Record<NotificationKind, React.ComponentType<{ className?: string }>> = {
  "shared-expense": Handshake,
  "share-joined": Handshake,
  "share-stopped": Handshake,
  "card-due": CalendarClock,
  "card-close": CreditCard,
  "recurring-due": Repeat,
  "agenda-today": CalendarDays,
  "agenda-invite": CalendarDays,
  "agenda-response": CalendarDays,
  "agenda-changed": CalendarDays,
  "agenda-cancelled": CalendarX,
  "connection-request": UserPlus,
  "connection-response": Users,
  "split-request": HandCoins,
  "split-response": HandCoins,
  "split-cancelled": HandCoins,
  "p2p-request": ArrowLeftRight,
  "p2p-response": ArrowLeftRight,
  "debt-reminder": HandCoins,
  "pending-reminder": Inbox,
  "weather-alert": CloudLightning,
  "weather-daily": CloudSun,
  test: Sparkles,
};

function KindIcon({ kind }: { kind: NotificationKind }) {
  const Icon = KIND_ICON[kind] ?? BellRing;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
      <Icon className="size-4" />
    </span>
  );
}

const rtf = new Intl.RelativeTimeFormat("es-AR", { numeric: "auto" });
const timeAgo = (d: Date) => {
  const secs = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(secs);
  if (abs < 60) return "recién";
  if (abs < 3600) return rtf.format(Math.round(secs / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(secs / 86400), "day");
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
};
