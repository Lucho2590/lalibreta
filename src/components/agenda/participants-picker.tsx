"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useContacts } from "@/hooks/use-data";
import { apiFetch } from "@/lib/api";
import { participantName, type ActivityParticipantStatus, type Invitee } from "@/lib/domain/activity-model";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STATUS_LABEL: Partial<Record<ActivityParticipantStatus, string>> = {
  pending: "Invitado",
  accepted: "Va",
  rejected: "No va",
};

/** Con quién es la actividad: contactos o cualquier email. */
export function ParticipantsPicker({
  value,
  onChange,
  statusOf,
  excludeEmail,
}: {
  value: Invitee[];
  onChange: (v: Invitee[]) => void;
  /** Estado de cada invitado (al editar una que ya existe). */
  statusOf?: (email: string) => ActivityParticipantStatus | undefined;
  /** El propio usuario: no se puede invitar a sí mismo. */
  excludeEmail?: string | null;
}) {
  const { data: contacts } = useContacts();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const has = (e: string) => value.some((v) => v.email.toLowerCase() === e.toLowerCase());
  const available = contacts.filter(
    (c) => !has(c.email) && c.email.toLowerCase() !== excludeEmail?.toLowerCase(),
  );

  const addContact = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    if (!c || has(c.email)) return;
    onChange([
      ...value,
      { uid: c.linkedUid ?? null, email: c.email.toLowerCase(), displayName: c.displayName ?? null, photoURL: c.photoURL ?? null },
    ]);
  };

  const addEmail = async () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return setError("Email inválido");
    if (e === excludeEmail?.toLowerCase()) return setError("Ese sos vos");
    if (has(e)) return setError("Ya está en la lista");
    const contact = contacts.find((c) => c.email.toLowerCase() === e);
    let inv: Invitee = {
      uid: contact?.linkedUid ?? null,
      email: e,
      displayName: contact?.displayName ?? null,
      photoURL: contact?.photoURL ?? null,
    };
    if (!contact) {
      setAdding(true);
      try {
        const r = await apiFetch(`/api/users/lookup?email=${encodeURIComponent(e)}`);
        if (r.ok) {
          const found = (await r.json()) as { uid: string; displayName: string | null; photoURL: string | null };
          inv = { ...inv, uid: found.uid, displayName: found.displayName, photoURL: found.photoURL };
        }
      } catch (err) {
        console.warn("[agenda] lookup falló", err);
      } finally {
        setAdding(false);
      }
    }
    onChange([...value, inv]);
    setEmail("");
    setError(null);
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((p) => {
            const status = statusOf?.(p.email);
            return (
              <span
                key={p.email}
                className="inline-flex items-center gap-1.5 rounded-full border bg-background py-1 pl-1 pr-2 text-xs"
              >
                <Avatar className="size-5">
                  {p.photoURL && <AvatarImage src={p.photoURL} alt="" />}
                  <AvatarFallback className="text-[10px]">{participantName(p)[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="max-w-32 truncate font-medium">{participantName(p)}</span>
                {status && STATUS_LABEL[status] && (
                  <span className="text-muted-foreground">· {STATUS_LABEL[status]}</span>
                )}
                <button
                  type="button"
                  onClick={() => onChange(value.filter((v) => v.email !== p.email))}
                  aria-label={`Quitar a ${participantName(p)}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {available.length > 0 && (
        <Select value="" onValueChange={(v) => v && addContact(v)}>
          <SelectTrigger className="h-10 w-full">
            <SelectValue
              placeholder="Sumar de mis contactos"
              items={available.map((c) => ({ value: c.id, label: c.displayName || c.email }))}
            />
          </SelectTrigger>
          <SelectContent>
            {available.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.displayName || c.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex gap-2">
        <Input
          type="email"
          placeholder="o invitar por email"
          className="h-10 flex-1"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addEmail();
            }
          }}
        />
        <Button type="button" variant="outline" className="h-10" onClick={addEmail} disabled={adding || !email.trim()}>
          <Plus className="size-4" /> {adding ? "…" : "Sumar"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
