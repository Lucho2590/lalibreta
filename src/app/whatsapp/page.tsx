"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  MessageCircle,
  Mic,
  Search,
  Unlink,
} from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Status {
  agentName: string | null;
  linked: boolean;
  phone: string | null;
  linkedAt: string | null;
  botNumber: string | null;
}

interface LinkCode {
  code: string;
  expiresAt: string;
  botNumber: string | null;
}

const fetchStatus = async (): Promise<Status | null> => {
  try {
    return await apiJson<Status>("/api/whatsapp/status");
  } catch (err) {
    console.error(err);
    toast.error("No se pudo consultar el estado de WhatsApp");
    return null;
  }
};

export default function WhatsappPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const applyStatus = useCallback((s: Status) => {
    setStatus(s);
    if (s.linked) setCode(null);
  }, []);

  const refresh = useCallback(async () => {
    const s = await fetchStatus();
    if (s) applyStatus(s);
    return s;
  }, [applyStatus]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void fetchStatus().then((s) => {
      if (!cancelled && s) applyStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [user, applyStatus]);

  // Mientras hay un código vigente, revisamos cada 3 s si ya se vinculó.
  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => {
      setNow(Date.now());
      void refresh().then((s) => {
        if (s?.linked) toast.success("¡WhatsApp vinculado!");
      });
    }, 3000);
    return () => clearInterval(id);
  }, [code, refresh]);

  const expired = code ? new Date(code.expiresAt).getTime() <= now : false;
  const secondsLeft = code
    ? Math.max(0, Math.round((new Date(code.expiresAt).getTime() - now) / 1000))
    : 0;

  const generate = async () => {
    setBusy(true);
    try {
      const c = await apiJson<LinkCode>("/api/whatsapp/link-code", { method: "POST" });
      setCode(c);
      setNow(Date.now());
    } catch (err) {
      console.error(err);
      toast.error("No se pudo generar el código");
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!confirm("¿Desvincular tu WhatsApp? Vas a dejar de poder cargar gastos desde ahí.")) return;
    setBusy(true);
    try {
      await apiJson("/api/whatsapp/unlink", { method: "POST" });
      toast.success("WhatsApp desvinculado");
      await refresh();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo desvincular");
    } finally {
      setBusy(false);
    }
  };

  const message = code ? `vincular ${code.code}` : "";
  const botNumber = code?.botNumber ?? status?.botNumber ?? null;
  const waLink = botNumber
    ? `https://wa.me/${botNumber.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          {status?.agentName ? (
            <>
              Tu agente de cuentas es <span className="font-semibold text-foreground">{status.agentName}</span>.
              Cargá gastos y consultá tus números por WhatsApp.
            </>
          ) : (
            "Cargá gastos y consultá tus números desde WhatsApp, con un asistente de IA"
          )}
        </p>
      </div>

      <Card className="rounded-3xl">
        <CardContent className="space-y-4 py-6">
          {!status && <p className="text-sm text-muted-foreground">Cargando…</p>}

          {status?.linked && (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
                  <CheckCircle2 className="size-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold">Vinculado</p>
                  <p className="text-xs text-muted-foreground">{status.phone}</p>
                </div>
              </div>
              <div className="flex gap-2">
                {status.botNumber && (
                  <a
                    href={`https://wa.me/${status.botNumber.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(buttonVariants({ variant: "outline" }), "gap-2 rounded-xl")}
                  >
                    <MessageCircle className="size-4" /> Abrir chat
                  </a>
                )}
                <Button
                  variant="ghost"
                  className="gap-2 rounded-xl text-destructive"
                  onClick={unlink}
                  disabled={busy}
                >
                  <Unlink className="size-4" /> Desvincular
                </Button>
              </div>
            </div>
          )}

          {status && !status.linked && !code && (
            <div className="space-y-3">
              <p className="text-sm">
                Vinculá tu número para empezar a hablar con {status.agentName ?? "tu agente"}. Cada
                persona de la familia vincula el suyo desde su propia cuenta.
              </p>
              <Button
                onClick={generate}
                disabled={busy}
                className="gap-2 rounded-xl bg-brand-grad text-white hover:opacity-95"
              >
                <MessageCircle className="size-4" /> Vincular WhatsApp
              </Button>
            </div>
          )}

          {status && !status.linked && code && (
            <div className="space-y-4">
              <p className="text-sm">
                Mandale este mensaje a {status.agentName ?? "tu agente"} desde tu WhatsApp:
              </p>
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-muted px-4 py-3">
                <code className="font-mono text-lg font-semibold tracking-wider">{message}</code>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Copiar"
                  onClick={() => {
                    void navigator.clipboard.writeText(message);
                    toast.success("Copiado");
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              {waLink && !expired && (
                <a
                  href={waLink}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    buttonVariants(),
                    "gap-2 rounded-xl bg-[#25D366] text-white hover:opacity-95",
                  )}
                >
                  <ExternalLink className="size-4" /> Abrir WhatsApp con el mensaje
                </a>
              )}
              <p className="text-xs text-muted-foreground">
                {expired ? (
                  <>
                    El código venció.{" "}
                    <button className="underline" onClick={generate} disabled={busy}>
                      Generar otro
                    </button>
                  </>
                ) : (
                  <>
                    Vence en {Math.floor(secondsLeft / 60)}:
                    {String(secondsLeft % 60).padStart(2, "0")}. Esta página se actualiza sola
                    cuando se vincule.
                  </>
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-3 sm:grid-cols-2">
        <Example
          icon={<MessageCircle className="size-4" />}
          title="Cargar un gasto"
          text={'"Gasté 15 lucas en el super con la visa en 3 cuotas"'}
        />
        <Example
          icon={<Mic className="size-4" />}
          title="Mandar un audio"
          text="Contale el gasto en una nota de voz y lo transcribe."
        />
        <Example
          icon={<ImageIcon className="size-4" />}
          title="Foto del ticket"
          text="Saca el monto, el comercio y la fecha del ticket."
        />
        <Example
          icon={<Search className="size-4" />}
          title="Consultas"
          text={'"¿Cuánto gasté este mes en comida?" · "¿Cuánto vence de la visa?"'}
        />
      </section>
      <p className="text-xs text-muted-foreground">
        Antes de guardar, el asistente siempre te muestra un resumen con los botones Confirmar y
        Cancelar.
      </p>
    </div>
  );
}

function Example({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="flex gap-3 py-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted">
          {icon}
        </span>
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{text}</p>
        </div>
      </CardContent>
    </Card>
  );
}
