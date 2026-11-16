"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { addOfflineContact } from "@/lib/domain/contacts";

/**
 * Persona que NO usa la app (un amigo, un familiar): solo el nombre es
 * obligatorio. Sirve para repartirle gastos o anotar préstamos y que la app
 * te recuerde cobrarle.
 */
export function ContactForm({ onCreated }: { onCreated?: (contactId: string, name: string) => void }) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user || !name.trim()) return;
    setBusy(true);
    try {
      const id = await addOfflineContact(user.uid, { name, email, phone });
      toast.success(`${name.trim()} agregado`);
      onCreated?.(id, name.trim());
      setName("");
      setEmail("");
      setPhone("");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="c-name">Nombre</Label>
        <Input id="c-name" className="h-12" placeholder="Ej: Juan" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="c-phone">Teléfono (opcional)</Label>
          <Input id="c-phone" className="h-11" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="c-email">Email (opcional)</Label>
          <Input id="c-email" className="h-11" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Si la persona usa La Libreta, mejor conectate con ella: así puede aceptar los gastos que le asignás.
      </p>
      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={busy || !name.trim()}>
        {busy ? "Guardando…" : "Agregar"}
      </Button>
    </form>
  );
}
