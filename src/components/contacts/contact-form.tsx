"use client";

import { useState } from "react";
import { Plus, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { apiPost, errorText } from "@/lib/api";
import { useContactLookup } from "./use-contact-lookup";
import { addOfflineContact, saveContactInfo } from "@/lib/domain/contacts";
import { cleanNicknames, type PayAlias } from "@/lib/domain/contact-info";
import type { Contact } from "@/lib/domain/types";

/**
 * Ficha de una persona: nombre, apodos (para que el agente la encuentre) y
 * alias/CBU para transferirle.
 * - Sin `contact`: agrega a alguien que NO usa la app (solo el nombre es obligatorio).
 * - Con `contact`: edita la ficha (de alguien sin la app o de un conectado; en
 *   ese caso el nombre es opcional y pisa el de su perfil).
 */
export function ContactForm({
  contact,
  initial,
  onSaved,
}: {
  contact?: Contact;
  /** Al agregar: teléfono o email que ya escribió en el buscador. */
  initial?: { phone?: string; email?: string };
  onSaved?: (contactId: string, name: string) => void;
}) {
  const { user } = useAuth();
  const isApp = !!contact && (!!contact.linkedUid || contact.kind === "app");
  const profileName = contact?.displayName?.trim() || contact?.email?.split("@")[0] || "";

  const [name, setName] = useState(isApp ? (contact?.customName ?? "") : (contact?.displayName ?? ""));
  const [nicknames, setNicknames] = useState<string[]>(contact?.nicknames ?? []);
  const [nickDraft, setNickDraft] = useState("");
  const [aliases, setAliases] = useState<PayAlias[]>(
    contact?.payAliases?.length ? contact.payAliases : [{ value: "", label: "" }],
  );
  const [email, setEmail] = useState(contact?.email ?? initial?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? initial?.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Al agregar a alguien "sin la app": si el teléfono o el email son de un
  // usuario, mejor conectarse (así acepta los gastos que le asignás).
  const phoneLookup = useContactLookup(contact ? "" : phone, 700);
  const emailLookup = useContactLookup(contact ? "" : email, 700);
  const appUser = [phoneLookup.result, emailLookup.result].find((r) => r?.found) ?? null;

  const connectInstead = async () => {
    if (!appUser) return;
    setConnecting(true);
    try {
      const r = await apiPost<{ status: string; name: string }>("/api/connections/request", { q: appUser.value });
      toast.success(r.status === "accepted" ? `Ya estás conectado con ${r.name}` : `Le mandamos la solicitud a ${r.name}`);
      onSaved?.("", r.name);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setConnecting(false);
    }
  };

  const addNick = (raw: string) => {
    const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length) setNicknames((prev) => cleanNicknames([...prev, ...parts]));
    setNickDraft("");
  };

  const setAlias = (i: number, patch: Partial<PayAlias>) =>
    setAliases((prev) => prev.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const canSave = isApp || !!name.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user || !canSave) return;
    // Lo que quedó escrito en el campo de apodos también cuenta.
    const allNicks = nickDraft.trim() ? cleanNicknames([...nicknames, ...nickDraft.split(",")]) : nicknames;
    const payAliases = aliases.filter((a) => a.value.trim());
    setBusy(true);
    try {
      const shown = name.trim() || profileName;
      if (contact) {
        await saveContactInfo(user.uid, contact, { name, nicknames: allNicks, payAliases, phone, email });
        toast.success("Guardado");
        onSaved?.(contact.id, shown);
      } else {
        const id = await addOfflineContact(user.uid, { name, nicknames: allNicks, payAliases, phone, email });
        toast.success(`${shown} agregado`);
        onSaved?.(id, shown);
        setName("");
        setNicknames([]);
        setNickDraft("");
        setAliases([{ value: "", label: "" }]);
        setEmail("");
        setPhone("");
      }
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="c-name">{isApp ? "Cómo le decís" : "Nombre"}</Label>
        <Input
          id="c-name"
          className="h-12"
          placeholder={isApp ? profileName : "Ej: Juan Pérez"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={!contact}
        />
        {isApp && (
          <p className="text-xs text-muted-foreground">
            Usa la app como <span className="font-medium">{profileName}</span>
            {contact?.email ? ` (${contact.email})` : ""}. Si lo dejás vacío, se muestra así.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="c-nick">Apodos</Label>
        {nicknames.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {nicknames.map((n) => (
              <span key={n} className="inline-flex items-center gap-1 rounded-full bg-muted py-1 pl-3 pr-1 text-sm">
                {n}
                <button
                  type="button"
                  aria-label={`Sacar ${n}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => setNicknames((prev) => prev.filter((x) => x !== n))}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            id="c-nick"
            className="h-11"
            placeholder="Ej: Juancho, mi cuñado"
            value={nickDraft}
            enterKeyHint="done"
            onChange={(e) => {
              const v = e.target.value;
              if (v.endsWith(",")) addNick(v);
              else setNickDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addNick(nickDraft);
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={!nickDraft.trim()}
            onClick={() => addNick(nickDraft)}
          >
            Sumar
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Cómo lo nombrás cuando le hablás al agente: así lo encuentra cuando decís &quot;dividilo con …&quot;.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Alias o CBU para transferirle</Label>
        <div className="space-y-2">
          {aliases.map((a, i) => (
            <div key={i} className="flex gap-2">
              <Input
                className="h-11 flex-[2]"
                placeholder="juan.perez.mp o CBU/CVU"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={a.value}
                aria-label="Alias, CBU o CVU"
                onChange={(e) => setAlias(i, { value: e.target.value })}
              />
              <Input
                className="h-11 min-w-0 flex-1"
                placeholder="MP, Galicia…"
                value={a.label ?? ""}
                aria-label="Banco o billetera (opcional)"
                onChange={(e) => setAlias(i, { label: e.target.value })}
              />
              {aliases.length > 1 && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-11 shrink-0"
                  aria-label="Sacar alias"
                  onClick={() => setAliases((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-ml-2 text-muted-foreground"
          onClick={() => setAliases((prev) => [...prev, { value: "", label: "" }])}
        >
          <Plus className="mr-1 size-4" /> Otro alias
        </Button>
      </div>

      <div className={isApp ? "space-y-1" : "grid grid-cols-2 gap-3"}>
        <div className="space-y-1">
          <Label htmlFor="c-phone">Teléfono (opcional)</Label>
          <Input id="c-phone" className="h-11" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {!isApp && (
          <div className="space-y-1">
            <Label htmlFor="c-email">Email (opcional)</Label>
            <Input id="c-email" className="h-11" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        )}
      </div>

      {appUser?.found && (
        <div className="flex items-center gap-3 rounded-2xl bg-brand/10 p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{appUser.name} usa La Libreta</div>
            <p className="text-xs text-muted-foreground">
              {appUser.state === "connected"
                ? "Ya están conectados: no hace falta agregarlo de nuevo."
                : appUser.state === "outgoing"
                  ? "Ya le mandaste la solicitud: falta que la acepte."
                  : appUser.state === "incoming"
                    ? "Te mandó una solicitud: aceptala en Contactos."
                    : appUser.state === "self"
                      ? "Ese sos vos 🙂"
                      : "Mandale la solicitud: cuando acepte, queda agendado y puede aceptar los gastos que le asignás."}
            </p>
          </div>
          {appUser.state === "none" && (
            <Button type="button" size="sm" disabled={connecting} onClick={connectInstead}>
              <Send className="mr-1 size-4" /> {connecting ? "Enviando…" : "Invitar"}
            </Button>
          )}
        </div>
      )}
      {!contact && !appUser && (
        <p className="text-xs text-muted-foreground">
          Si la persona usa La Libreta, mejor conectate con ella: así puede aceptar los gastos que le asignás.
        </p>
      )}
      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={busy || !canSave}>
        {busy ? "Guardando…" : contact ? "Guardar" : "Agregar"}
      </Button>
    </form>
  );
}
