"use client";

import { useEffect } from "react";
import { Trash2, Users } from "lucide-react";
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
import { formatCurrency } from "@/lib/format";

export interface ShareSplit {
  contactId: string;
  email: string;
  displayName: string | null;
  uid: string | null;
  photoURL: string | null;
  percentage: number;
}

interface Props {
  totalAmount: number;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  splits: ShareSplit[];
  onSplitsChange: (splits: ShareSplit[]) => void;
}

export function ShareSection({
  totalAmount,
  enabled,
  onEnabledChange,
  splits,
  onSplitsChange,
}: Props) {
  const { data: contacts } = useContacts();

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

  const addSplit = (contactId: string) => {
    const c = contacts.find((x) => x.id === contactId);
    if (!c) return;
    if (splits.find((s) => s.contactId === contactId)) return;
    const remaining = Math.max(0, 100 - total);
    const next: ShareSplit = {
      contactId,
      email: c.email,
      displayName: c.displayName ?? null,
      uid: c.linkedUid ?? null,
      photoURL: c.photoURL ?? null,
      percentage: remaining > 0 ? remaining : 0,
    };
    // Reasignar 50/50 si es el primer split.
    if (splits.length === 0) {
      onSplitsChange([{ ...next, percentage: 50 }]);
    } else {
      onSplitsChange([...splits, next]);
    }
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
    (c) => !splits.find((s) => s.contactId === c.id),
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
          {contacts.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
              Necesitás contactos para compartir un gasto.{" "}
              <a className="font-medium underline" href="/contactos">
                Agregar contacto
              </a>
            </p>
          ) : (
            <>
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

              <div className="flex flex-wrap items-center gap-2">
                {availableContacts.length > 0 && (
                  <Select value="" onValueChange={(v) => v && addSplit(v)}>
                    <SelectTrigger className="h-9 flex-1">
                      <SelectValue
                        placeholder="Agregar contacto"
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
                )}
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

              {!sumValid && (
                <p className="text-xs text-destructive">
                  Los porcentajes suman más de 100%. Ajustá los valores.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
