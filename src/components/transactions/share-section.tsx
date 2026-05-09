"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useContacts } from "@/hooks/use-data";
import { apiFetch } from "@/lib/api";
import { formatCurrency } from "@/lib/format";

interface UserLookup {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
}

export interface ShareSplit {
  contactId: string;
  email: string;
  displayName: string | null;
  uid: string | null;
  photoURL: string | null;
  percentage: number;
  saveAsContact?: boolean;
}

interface Props {
  totalAmount: number;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  splits: ShareSplit[];
  onSplitsChange: (splits: ShareSplit[]) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const adhocId = (email: string) => `email:${email.trim().toLowerCase()}`;

export function ShareSection({
  totalAmount,
  enabled,
  onEnabledChange,
  splits,
  onSplitsChange,
}: Props) {
  const { data: contacts } = useContacts();
  const [emailDraft, setEmailDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [saveAsContact, setSaveAsContact] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const ownerPct = Math.max(
    0,
    100 - splits.reduce((s, x) => s + (Number.isFinite(x.percentage) ? x.percentage : 0), 0),
  );
  const total = splits.reduce((s, x) => s + x.percentage, 0);
  const sumValid = total <= 100;

  // Si toggle se apaga, limpiar splits.
  useEffect(() => {
    if (!enabled && splits.length > 0) onSplitsChange([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const addSplitFromContact = (contactId: string) => {
    const c = contacts.find((x) => x.id === contactId);
    if (!c) return;
    if (splits.find((s) => s.contactId === contactId)) return;
    pushSplit({
      contactId,
      email: c.email,
      displayName: c.displayName ?? null,
      uid: c.linkedUid ?? null,
      photoURL: c.photoURL ?? null,
    });
  };

  const addSplitFromEmail = async () => {
    const email = emailDraft.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      setEmailError("Email inválido");
      return;
    }
    const id = adhocId(email);
    const dupe =
      splits.find((s) => s.email.toLowerCase() === email) ||
      splits.find((s) => s.contactId === id);
    if (dupe) {
      setEmailError("Ya está en la lista");
      return;
    }
    const matchingContact = contacts.find(
      (c) => c.email.toLowerCase() === email,
    );

    // Si no hay contacto, intentamos resolver el uid contra usuarios registrados
    // para que el invitado pueda ver el gasto en su cuenta de la app.
    let resolvedUid = matchingContact?.linkedUid ?? null;
    let resolvedName = nameDraft.trim() || matchingContact?.displayName || null;
    let resolvedPhoto = matchingContact?.photoURL ?? null;
    if (!matchingContact) {
      setAdding(true);
      try {
        const r = await apiFetch(
          `/api/users/lookup?email=${encodeURIComponent(email)}`,
        );
        if (r.ok) {
          const found = (await r.json()) as UserLookup;
          resolvedUid = found.uid;
          resolvedName = resolvedName || found.displayName;
          resolvedPhoto = found.photoURL ?? null;
        }
      } catch (err) {
        console.warn("[shareSection] users lookup falló", err);
      } finally {
        setAdding(false);
      }
    }

    pushSplit({
      contactId: matchingContact?.id ?? id,
      email,
      displayName: resolvedName,
      uid: resolvedUid,
      photoURL: resolvedPhoto,
      saveAsContact: !matchingContact && saveAsContact,
    });
    setEmailDraft("");
    setNameDraft("");
    setSaveAsContact(false);
    setEmailError(null);
  };

  const pushSplit = (next: Omit<ShareSplit, "percentage">) => {
    const remaining = Math.max(0, 100 - total);
    const pct = splits.length === 0 ? 50 : remaining;
    onSplitsChange([...splits, { ...next, percentage: pct }]);
  };

  const removeSplit = (contactId: string) => {
    onSplitsChange(splits.filter((s) => s.contactId !== contactId));
  };

  const setPercentage = (contactId: string, pct: number) => {
    const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    onSplitsChange(
      splits.map((s) => (s.contactId === contactId ? { ...s, percentage: clamped } : s)),
    );
  };

  const splitEqually = () => {
    if (splits.length === 0) return;
    const each = Math.floor(100 / (splits.length + 1));
    onSplitsChange(splits.map((s) => ({ ...s, percentage: each })));
  };

  const availableContacts = contacts.filter(
    (c) =>
      !splits.find(
        (s) =>
          s.contactId === c.id ||
          s.email.toLowerCase() === c.email.toLowerCase(),
      ),
  );

  return (
    <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-muted-foreground" />
          <Label htmlFor="share-toggle" className="text-sm font-medium">
            Compartirlo con alguien
          </Label>
        </div>
        <Switch
          id="share-toggle"
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </div>

      {enabled && (
        <>
          {splits.length > 0 && (
            <div className="space-y-2">
              {splits.map((s) => (
                <div
                  key={s.contactId}
                  className="flex items-center gap-2 rounded-lg bg-background p-2"
                >
                  <Avatar className="size-8">
                    {s.photoURL && <AvatarImage src={s.photoURL} alt="" />}
                    <AvatarFallback>
                      {(s.displayName?.[0] ?? s.email[0] ?? "?").toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {s.displayName || s.email}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {totalAmount > 0
                        ? formatCurrency((totalAmount * s.percentage) / 100)
                        : "—"}
                      {s.saveAsContact && " · se guardará en contactos"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      className="h-8 w-16 text-right"
                      value={s.percentage}
                      onChange={(e) =>
                        setPercentage(s.contactId, Number(e.target.value))
                      }
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => removeSplit(s.contactId)}
                    aria-label="Quitar"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {splits.length > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-background p-2 text-sm">
              <span className="font-medium">Te toca a vos</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{ownerPct}%</span>
                <span className="font-semibold tabular-nums">
                  {totalAmount > 0
                    ? formatCurrency((totalAmount * ownerPct) / 100)
                    : "—"}
                </span>
              </div>
            </div>
          )}

          {availableContacts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value="" onValueChange={(v) => v && addSplitFromContact(v)}>
                <SelectTrigger className="h-9 flex-1">
                  <SelectValue
                    placeholder="Agregar de contactos"
                    items={availableContacts.map((c) => ({
                      value: c.id,
                      label: c.displayName || c.email,
                    }))}
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableContacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName || c.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {splits.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={splitEqually}
                >
                  Dividir igual
                </Button>
              )}
            </div>
          )}

          <div className="rounded-lg border border-dashed bg-background p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Agregar por email
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                placeholder="email@ejemplo.com"
                className="h-9 flex-1"
                value={emailDraft}
                onChange={(e) => {
                  setEmailDraft(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSplitFromEmail();
                  }
                }}
              />
              <Input
                type="text"
                placeholder="Nombre (opcional)"
                className="h-9 sm:w-44"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                onClick={addSplitFromEmail}
                disabled={adding}
              >
                <Plus className="size-3.5" /> {adding ? "Agregando…" : "Agregar"}
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 rounded border-input"
                checked={saveAsContact}
                onChange={(e) => setSaveAsContact(e.target.checked)}
              />
              Guardar en mis contactos
            </label>
            {emailError && (
              <p className="text-xs text-destructive">{emailError}</p>
            )}
          </div>

          {splits.length === 0 && (
            <p className="text-center text-xs text-muted-foreground">
              Agregá a alguien por contacto o por email para dividir el gasto.
            </p>
          )}

          {!sumValid && (
            <p className="text-xs text-destructive">
              Los porcentajes suman más de 100%. Ajustá los valores.
            </p>
          )}
        </>
      )}
    </div>
  );
}
