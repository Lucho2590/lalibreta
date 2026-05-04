"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/api";
import { upsertContact } from "@/lib/domain/contacts";

interface LookupResult {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
}

export function ContactForm({ onCreated }: { onCreated?: () => void }) {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookupChecked, setLookupChecked] = useState(false);

  const checkRegistered = async () => {
    if (!user) return;
    const e = email.trim().toLowerCase();
    if (!e) return;
    setLookupChecked(false);
    try {
      const r = await apiFetch(`/api/users/lookup?email=${encodeURIComponent(e)}`);
      if (r.ok) {
        const data = (await r.json()) as LookupResult;
        setLookup(data);
        if (!name && data.displayName) setName(data.displayName);
      } else {
        setLookup(null);
      }
      setLookupChecked(true);
    } catch (err) {
      console.error(err);
      setLookup(null);
      setLookupChecked(true);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!user || !cleanEmail) return;
    if (cleanEmail === user.email?.toLowerCase()) {
      toast.error("No te podés agregar a vos mismo");
      return;
    }
    setBusy(true);
    try {
      // Si no chequeó manualmente, hacemos el lookup en el submit.
      let resolvedLookup = lookup;
      if (!lookupChecked) {
        try {
          const r = await apiFetch(
            `/api/users/lookup?email=${encodeURIComponent(cleanEmail)}`,
          );
          if (r.ok) resolvedLookup = (await r.json()) as LookupResult;
        } catch (err) {
          console.warn("[contact] lookup falló", err);
        }
      }

      await upsertContact(user.uid, {
        email: cleanEmail,
        displayName: name.trim() || resolvedLookup?.displayName || null,
        linkedUid: resolvedLookup?.uid ?? null,
        photoURL: resolvedLookup?.photoURL ?? null,
      });
      toast.success(
        resolvedLookup ? `Contacto agregado · ${resolvedLookup.email} está en la app` : "Contacto agregado",
      );
      setEmail("");
      setName("");
      setLookup(null);
      setLookupChecked(false);
      onCreated?.();
    } catch (err) {
      toast.error("No se pudo guardar el contacto");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="contact-email">Email</Label>
        <div className="flex gap-2">
          <Input
            id="contact-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            className="h-12 flex-1"
            placeholder="alguien@mail.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setLookupChecked(false);
              setLookup(null);
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="h-12"
            onClick={checkRegistered}
            disabled={!email.trim()}
            aria-label="Buscar en la app"
          >
            <Search className="size-4" />
          </Button>
        </div>
        {lookupChecked && (
          <p className="text-xs text-muted-foreground">
            {lookup
              ? `Encontramos a ${lookup.displayName ?? lookup.email} en la app.`
              : "No está registrado todavía. Lo agregás igual y cuando se sume vinculamos."}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="contact-name">Nombre (opcional)</Label>
        <Input
          id="contact-name"
          className="h-12"
          placeholder="Ej: Pepito"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <Button
        type="submit"
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        disabled={busy || !email.trim()}
      >
        {busy ? "Guardando…" : "Agregar contacto"}
      </Button>
    </form>
  );
}
