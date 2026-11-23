"use client";

import { useState } from "react";
import { Loader2, Mail, MessageCircle, Plus, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import type { PersonOption } from "@/hooks/use-data";
import { useContactLookup, type LookupResult } from "@/components/contacts/use-contact-lookup";
import { formatPhone, inviteMessage, waMeLink } from "@/lib/domain/phone";

/** Lo que eligió: alguien de sus contactos, alguien buscado por WhatsApp/email, o un nombre suelto (sin la app). */
export type PersonPick =
  | { type: "person"; person: PersonOption }
  | { type: "query"; q: string; name: string; found: boolean }
  | { type: "name"; name: string };

const MAX_SHOWN = 6;
const MAX_SUGGESTED = 3;
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

const STATE_TEXT: Record<string, string> = {
  connected: "Es tu contacto",
  outgoing: "Ya le mandaste la solicitud",
  incoming: "Te mandó una solicitud",
  none: "Usa La Libreta",
};

/**
 * Buscar a alguien entre tus contactos (por nombre, apodo o email) o por su
 * WhatsApp / email aunque no sea tu contacto. Escala con muchos contactos:
 * nunca lista todos, solo las sugerencias y lo que coincide con lo que escribe.
 */
export function PersonSearch({
  people,
  rank,
  onPick,
  allowName = false,
  busy = false,
  placeholder = "Nombre, WhatsApp o email",
  foundHint,
}: {
  people: PersonOption[];
  /** Qué tan sugerida es cada persona (0 = nada): las sugeridas se muestran sin escribir. */
  rank?: (p: PersonOption) => number;
  onPick: (pick: PersonPick) => void | Promise<unknown>;
  /** Se puede sumar a alguien sin la app solo con el nombre. */
  allowName?: boolean;
  busy?: boolean;
  placeholder?: string;
  /** Qué pasa si elige a alguien de La Libreta que no es su contacto (ej. "se vincula cuando acepte"). */
  foundHint?: string;
}) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [inviteName, setInviteName] = useState("");
  const { query, loading, result, error } = useContactLookup(text);
  const t = norm(text);
  const score = (p: PersonOption) => rank?.(p) ?? 0;

  const pick = async (p: PersonPick) => {
    await onPick(p);
    setText("");
    setInviteName("");
  };

  const suggested = !t ? people.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a)).slice(0, MAX_SUGGESTED) : [];
  const matches = t
    ? people
        .filter((p) => [p.name, ...(p.nicknames ?? []), p.email ?? ""].some((x) => norm(x).includes(t)))
        .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, "es"))
    : [];
  const shown = t ? matches.slice(0, MAX_SHOWN) : suggested;

  const queryLabel = (r: LookupResult) => (r.kind === "phone" ? formatPhone(r.value) : r.value);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-10 bg-background pl-9"
          placeholder={placeholder}
          value={text}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
      </div>

      {shown.length > 0 && (
        <div className="divide-y overflow-hidden rounded-xl border bg-background">
          {!t && <div className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sugerido</div>}
          {shown.map((p) => (
            <button
              key={p.ref}
              type="button"
              disabled={busy}
              onClick={() => pick({ type: "person", person: p })}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-50"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {p.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.isApp ? "Usa La Libreta" : "Sin la app"}
                  {p.email ? ` · ${p.email}` : ""}
                </span>
              </span>
              <Plus className="size-4 text-brand" />
            </button>
          ))}
        </div>
      )}
      {t && matches.length > MAX_SHOWN && (
        <p className="text-xs text-muted-foreground">Y {matches.length - MAX_SHOWN} más: seguí escribiendo.</p>
      )}
      {!t && suggested.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {people.length > 0 ? `Buscá entre tus ${people.length} contactos o escribí su WhatsApp o email.` : "Escribí su WhatsApp o su email."}
        </p>
      )}

      {/* Buscar en La Libreta por WhatsApp / email */}
      {query && loading && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Buscando en La Libreta…
        </p>
      )}
      {query && error && <p className="text-xs text-destructive">{error}</p>}
      {result?.found && result.state !== "self" && (
        <div className="flex items-center gap-3 rounded-xl bg-muted/60 p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{result.name}</div>
            <div className="text-xs text-muted-foreground">
              {STATE_TEXT[result.state] ?? "Usa La Libreta"}
              {result.state !== "connected" && foundHint ? `. ${foundHint}` : ""}
            </div>
          </div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => pick({ type: "query", q: result.value, name: result.name, found: true })}
          >
            {result.state === "connected" ? (
              "Elegir"
            ) : (
              <>
                <Send className="mr-1 size-4" /> Elegir
              </>
            )}
          </Button>
        </div>
      )}
      {result?.found && result.state === "self" && <p className="text-xs text-muted-foreground">Ese sos vos 🙂</p>}
      {result && !result.found && (
        <div className="space-y-2 rounded-xl bg-muted/60 p-3">
          <div className="text-sm [overflow-wrap:anywhere]">
            <span className="font-semibold">{queryLabel(result)}</span> no usa La Libreta. Lo invitamos y, cuando se sume, queda
            vinculado solo.
          </div>
          {allowName && (
            <Input
              className="h-9 bg-background"
              placeholder="¿Cómo se llama?"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
            />
          )}
          {result.kind === "phone" ? (
            <Button
              size="sm"
              disabled={busy || (allowName && !inviteName.trim())}
              nativeButton={false}
              render={
                <a
                  href={waMeLink(result.value, inviteMessage(user?.displayName, typeof window === "undefined" ? "" : window.location.origin))}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    if (allowName && !inviteName.trim()) {
                      e.preventDefault();
                      return;
                    }
                    void pick({ type: "query", q: result.value, name: inviteName.trim(), found: false });
                  }}
                />
              }
            >
              <MessageCircle className="mr-1 size-4" /> Invitar por WhatsApp
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy || (allowName && !inviteName.trim())}
              onClick={() => pick({ type: "query", q: result.value, name: inviteName.trim(), found: false })}
            >
              <Mail className="mr-1 size-4" /> Invitar por mail
            </Button>
          )}
        </div>
      )}

      {/* Alguien sin la app, solo con el nombre */}
      {allowName && t && !query && (
        <button
          type="button"
          disabled={busy}
          onClick={() => pick({ type: "name", name: text.trim() })}
          className="flex w-full items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50"
        >
          <Plus className="size-4" /> Sumar a «{text.trim()}» sin la app
        </button>
      )}
      {!allowName && t && !query && matches.length === 0 && (
        <p className="text-xs text-muted-foreground">No está en tus contactos: escribí su WhatsApp o su email para buscarlo.</p>
      )}
    </div>
  );
}

/** Alguien elegido para sumar (todavía no se mandó). */
export interface SelectedPerson {
  key: string;
  label: string;
  /** Lo que va al server (MemberInput). */
  input: { ref?: string; q?: string; name?: string };
  /** Usa La Libreta (o la va a usar: se lo buscó por WhatsApp/email). */
  isApp: boolean;
  note?: string;
}

let seq = 0;
export const selectedFromPick = (p: PersonPick): SelectedPerson => {
  seq += 1;
  if (p.type === "person") return { key: p.person.ref, label: p.person.name, input: { ref: p.person.ref }, isApp: p.person.isApp };
  if (p.type === "query") {
    return {
      key: `q:${p.q}`,
      label: p.name || p.q,
      input: { q: p.q, name: p.name },
      isApp: p.found,
      note: p.found ? "le mandamos la solicitud" : "invitado",
    };
  }
  return { key: `n:${seq}:${p.name}`, label: p.name, input: { name: p.name }, isApp: false, note: "sin la app" };
};
