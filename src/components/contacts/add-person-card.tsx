"use client";

import { useState } from "react";
import { Loader2, Mail, MessageCircle, Search, Send, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { apiPost, errorText } from "@/lib/api";
import { formatPhone, inviteMessage, waMeLink } from "@/lib/domain/phone";
import { useContactLookup, type LookupResult } from "./use-contact-lookup";
import { AddressBookButton } from "./address-book-sheet";

export interface OfflineDraft {
  phone?: string;
  email?: string;
}

const STATE_TEXT: Record<string, string> = {
  self: "Ese sos vos 🙂",
  connected: "Ya están conectados.",
  outgoing: "Ya le mandaste la solicitud: falta que la acepte.",
  incoming: "Te mandó una solicitud: aceptala arriba.",
};

/**
 * Agregar a alguien por su WhatsApp o su email. Mientras escribe, se fija si
 * usa La Libreta: si la usa, le manda la solicitud (cuando acepta queda
 * agendado como usuario); si no, lo invita por WhatsApp o por mail, o lo
 * agenda sin app.
 */
export function AddPersonCard({ onAddOffline }: { onAddOffline: (draft: OfflineDraft) => void }) {
  const { user } = useAuth();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const { query, loading, result, error, refresh } = useContactLookup(raw);

  const connect = async (r: LookupResult) => {
    setBusy(true);
    try {
      const res = await apiPost<{ status: string; name: string }>("/api/connections/request", { q: r.value });
      toast.success(
        res.status === "accepted" ? `Ya estás conectado con ${res.name}` : `Le mandamos la solicitud a ${res.name}`,
      );
      setRaw("");
    } catch (err) {
      toast.error(errorText(err));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const inviteByEmail = async (email: string) => {
    setBusy(true);
    try {
      await apiPost("/api/connections/invite", { email });
      toast.success(`Le mandamos la invitación a ${email}`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const offlineDraft = (r: LookupResult): OfflineDraft =>
    r.kind === "phone" ? { phone: formatPhone(r.value) } : { email: r.value };

  const trimmed = raw.trim();

  return (
    <Card className="rounded-3xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
          <UserPlus className="size-4" /> Agregar contacto
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Escribí su WhatsApp o su email y te decimos si ya usa La Libreta. Si la usa, le llega una solicitud y,
          cuando acepta, pueden repartir gastos y registrar transferencias entre ustedes.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-11 pl-9"
            placeholder="11 5555-1234 o juan@gmail.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </div>

        {/* La agenda solo tiene sentido en el celular (pantalla táctil), no en la compu. */}
        {!trimmed && (
          <div className="hidden pointer-coarse:block">
            <AddressBookButton />
          </div>
        )}

        {trimmed && !query && (
          <p className="text-xs text-muted-foreground">
            Escribí un email o un WhatsApp con característica (ej. 11 5555-1234 o 223 555-1234).
          </p>
        )}

        {loading && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Buscando…
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {result?.found && (
          <div className="flex items-center gap-3 rounded-2xl bg-muted/60 p-3">
            <Avatar className="size-10">
              {result.photoURL && <AvatarImage src={result.photoURL} alt="" />}
              <AvatarFallback>{result.name.trim()[0]?.toUpperCase() ?? "?"}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{result.name}</div>
              <div className="text-xs text-muted-foreground">
                {STATE_TEXT[result.state] ?? "Usa La Libreta ✨"}
              </div>
            </div>
            {result.state === "none" && (
              <Button size="sm" disabled={busy} onClick={() => connect(result)}>
                <Send className="mr-1 size-4" /> {busy ? "Enviando…" : "Invitar"}
              </Button>
            )}
          </div>
        )}

        {result && !result.found && (
          <div className="space-y-3 rounded-2xl bg-muted/60 p-3">
            <div>
              <div className="text-sm font-semibold">
                {result.kind === "phone" ? formatPhone(result.value) : result.value} no usa La Libreta
              </div>
              <p className="text-xs text-muted-foreground">
                {result.kind === "phone"
                  ? "Ningún usuario tiene ese número vinculado a su WhatsApp. Si usa la app, probá con su email."
                  : "Nadie se registró con ese email. Si usa la app, probá con su WhatsApp o con otro email."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {result.kind === "phone" ? (
                <Button
                  size="sm"
                  nativeButton={false}
                  render={
                    <a
                      href={waMeLink(result.value, inviteMessage(user?.displayName, window.location.origin))}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  <MessageCircle className="mr-1 size-4" /> Invitar por WhatsApp
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => inviteByEmail(result.value)}>
                  <Mail className="mr-1 size-4" /> {busy ? "Enviando…" : "Mandarle un mail"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onAddOffline(offlineDraft(result))}>
                Agendar sin app
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
