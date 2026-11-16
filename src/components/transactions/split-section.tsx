"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { usePeople } from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { addOfflineContact } from "@/lib/domain/contacts";
import { computeShares, contactRef, type PersonRef, type SplitMode } from "@/lib/domain/people";
import type { Currency } from "@/lib/domain/types";
import { formatMoney, parseAmount } from "@/lib/format";

export interface SplitPerson {
  ref: PersonRef;
  name: string;
  isApp: boolean;
  shareType: "percent" | "amount";
  /** Lo que escribió (% o monto). */
  input: string;
}

export interface SplitState {
  enabled: boolean;
  people: SplitPerson[];
  mode: SplitMode;
}

export const emptySplit = (): SplitState => ({ enabled: false, people: [], mode: "installments" });

/** Partes listas para mandar al server (o el error para mostrar). */
export const splitPayload = (total: number, s: SplitState) => {
  const participants = s.people.map((p) => ({ ref: p.ref, shareType: p.shareType, value: parseAmount(p.input) || 0 }));
  const { amounts, error } = computeShares(total, participants);
  return { participants, amounts, error: s.people.length === 0 ? "Elegí con quién dividirlo" : error };
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);

/**
 * "Dividirlo con otras personas": a quién le toca cuánto (% o $). Los que
 * usan la app lo tienen que aceptar; los que no, te lo deben.
 */
export function SplitSection({
  totalAmount,
  currency,
  installments,
  value,
  onChange,
}: {
  totalAmount: number;
  currency: Currency;
  /** Cuotas del gasto (si es más de 1, se elige cómo te lo pagan). */
  installments: number;
  value: SplitState;
  onChange: (s: SplitState) => void;
}) {
  const { user } = useAuth();
  const { data: people } = usePeople();
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const set = (patch: Partial<SplitState>) => onChange({ ...value, ...patch });
  const setPerson = (ref: PersonRef, patch: Partial<SplitPerson>) =>
    set({ people: value.people.map((p) => (p.ref === ref ? { ...p, ...patch } : p)) });

  const available = people.filter((p) => !value.people.some((x) => x.ref === p.ref));
  const known = new Set(people.map((p) => p.ref));
  const { amounts, error } = splitPayload(totalAmount, value);
  const others = r2(amounts.reduce((s, a) => s + a, 0));
  const mine = r2(totalAmount - others);

  const addPerson = (ref: string) => {
    const p = people.find((x) => x.ref === ref);
    if (!p) return;
    const n = value.people.length + 2;
    set({
      people: [...value.people, { ref: p.ref, name: p.name, isApp: p.isApp, shareType: "percent", input: num(r2(100 / n)) }],
    });
  };

  const addOffline = async () => {
    if (!user || !newName.trim()) return;
    setAdding(true);
    try {
      const id = await addOfflineContact(user.uid, { name: newName });
      set({
        people: [
          ...value.people,
          { ref: contactRef(id), name: newName.trim(), isApp: false, shareType: "percent", input: num(r2(100 / (value.people.length + 2))) },
        ],
      });
      setNewName("");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo agregar");
    } finally {
      setAdding(false);
    }
  };

  const splitEqually = () => {
    const each = r2(100 / (value.people.length + 1));
    set({ people: value.people.map((p) => ({ ...p, shareType: "percent", input: num(each) })) });
  };

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor="split-on" className="flex items-center gap-1.5 text-sm">
            <Users className="size-4" /> Dividirlo con otras personas
          </Label>
          <p className="text-xs text-muted-foreground">Le asignás una parte (% o monto) a cada uno.</p>
        </div>
        <Switch id="split-on" checked={value.enabled} onCheckedChange={(v) => set({ enabled: v })} />
      </div>

      {value.enabled && (
        <>
          {value.people.map((p, i) => (
            <div key={p.ref} className="flex items-center gap-2 rounded-lg bg-background p-2">
              <Avatar className="size-8">
                <AvatarFallback>{p.name[0]?.toUpperCase() ?? "?"}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {!known.has(p.ref) && p.isApp ? (
                    <span className="text-destructive">
                      No están conectados ·{" "}
                      <Link href="/contactos" className="underline">
                        conectate
                      </Link>
                    </span>
                  ) : p.isApp ? (
                    "Lo tiene que aceptar"
                  ) : (
                    "Sin la app: te lo debe"
                  )}
                  {amounts[i] > 0 && ` · ${formatMoney(amounts[i], currency)}`}
                </div>
              </div>
              <Input
                className="h-9 w-20 text-right"
                inputMode="decimal"
                value={p.input}
                onChange={(e) => setPerson(p.ref, { input: e.target.value })}
                aria-label={`Parte de ${p.name}`}
              />
              <div className="inline-flex rounded-md bg-muted p-0.5">
                {(["percent", "amount"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      setPerson(p.ref, {
                        shareType: t,
                        // Al cambiar de % a $ (o al revés), mantiene la misma parte.
                        input:
                          t === p.shareType || !(amounts[i] > 0)
                            ? p.input
                            : num(t === "amount" ? amounts[i] : r2((amounts[i] / (totalAmount || 1)) * 100)),
                      })
                    }
                    className={`h-7 rounded px-2 text-xs font-medium ${p.shareType === t ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  >
                    {t === "percent" ? "%" : currency === "USD" ? "US$" : "$"}
                  </button>
                ))}
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => set({ people: value.people.filter((x) => x.ref !== p.ref) })}
                aria-label="Sacar"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            {available.length > 0 && (
              <Select value="" onValueChange={(v) => v && addPerson(v)}>
                <SelectTrigger className="h-9 min-w-44">
                  <SelectValue placeholder="Agregar persona…" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((p) => (
                    <SelectItem key={p.ref} value={p.ref}>
                      {p.name}
                      <span className="text-muted-foreground"> · {p.isApp ? "en la app" : "sin app"}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {value.people.length > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={splitEqually}>
                Dividir igual
              </Button>
            )}
          </div>

          <div className="flex gap-2">
            <Input
              className="h-9"
              placeholder="Alguien sin la app (nombre)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addOffline();
                }
              }}
            />
            <Button type="button" size="sm" variant="outline" className="h-9" onClick={addOffline} disabled={adding || !newName.trim()}>
              <Plus className="mr-1 size-4" /> Agregar
            </Button>
          </div>
          {people.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Para dividir con alguien que usa La Libreta, primero{" "}
              <Link href="/contactos" className="underline">
                conectate desde Contactos
              </Link>
              .
            </p>
          )}

          {installments > 1 && value.people.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">¿Cómo te lo pagan?</Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-0.5">
                {(
                  [
                    { v: "installments", label: `En ${installments} cuotas` },
                    { v: "lump", label: "Todo junto" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => set({ mode: o.v })}
                    className={`h-8 rounded-md text-xs font-medium ${value.mode === o.v ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {value.people.length > 0 && totalAmount > 0 && (
            <div className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
              {error ?? (
                <>
                  Te toca a vos: <span className="font-semibold text-foreground">{formatMoney(mine, currency)}</span>
                  {value.people.some((p) => p.isApp) && " · hasta que acepten, cuenta entero para vos"}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
