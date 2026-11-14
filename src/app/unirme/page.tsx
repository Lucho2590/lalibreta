"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Handshake } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";

export default function UnirmePage() {
  const router = useRouter();
  // Link de la invitación: /unirme?codigo=123456. (Esta página solo se
  // renderiza en el cliente: ProtectedRoute espera la sesión.)
  const [code, setCode] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("codigo") ?? "").replace(/\D/g, "").slice(0, 6),
  );
  const [busy, setBusy] = useState(false);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    try {
      const r = await apiFetch("/api/account-shares/join", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = (await r.json()) as {
        error?: string;
        ownerName?: string;
        accounts?: string[];
        alreadyHad?: boolean;
      };
      if (!r.ok) {
        toast.error(data.error ?? "No se pudo usar el código");
        return;
      }
      const names = (data.accounts ?? []).join(", ");
      toast.success(
        data.alreadyHad
          ? `Ya tenías acceso a ${names}`
          : `¡Listo! Ya compartís ${names} de ${data.ownerName}`,
      );
      router.replace("/cuentas");
    } catch (err) {
      toast.error("No se pudo usar el código");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Card className="rounded-3xl">
        <CardContent className="space-y-5 py-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-brand/15 text-brand">
              <Handshake className="size-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Unirme a una cuenta compartida</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Ingresá el código de 6 dígitos que te pasaron. Vas a poder cargar gastos en esa
                cuenta y ver cómo viene.
              </p>
            </div>
          </div>
          <form onSubmit={join} className="space-y-3">
            <Label htmlFor="share-code" className="sr-only">
              Código
            </Label>
            <Input
              id="share-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              className="h-14 text-center font-mono text-2xl tracking-[0.3em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <Button
              type="submit"
              className="h-11 w-full bg-brand-grad text-white hover:opacity-95"
              disabled={busy || code.length !== 6}
            >
              {busy ? "Uniéndome…" : "Unirme"}
            </Button>
          </form>
          <p className="text-center text-xs text-muted-foreground">
            También podés reenviarle el mensaje de la invitación a tu agente de WhatsApp.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
