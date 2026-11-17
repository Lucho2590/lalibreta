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
  /** Dividir siempre así los gastos de ese comercio/servicio. */
  always?: boolean;
}

export const emptySplit = (): SplitState => ({ enabled: false, people: [], mode: "installments", always: false });

/** ¿Los montos se escriben y se muestran por cuota? (gasto en cuotas que se paga en cuotas) */
export const perCuota = (s: Pick<SplitState, "mode">, installments: number) => installments > 1 && s.mode === "installments";

/**
 * Partes listas para mandar al server (o el error para mostrar). Si se paga
 * en cuotas, los montos en $ se escriben por cuota: acá se pasan al total.
 */
export const splitPayload = (total: number, s: SplitState, installments = 1) => {
  const k = perCuota(s, installments) ? installments : 1;
  const participants = s.people.map((p) => {
    const v = parseAmount(p.input) || 0;
    return { ref: p.ref, shareType: p.shareType, value: p.shareType === "amount" ? r2(v * k) : v };
  });
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
  alwaysOn = false,
  alwaysLabel,
}: {
  totalAmount: number;
  currency: Currency;
  /** Cuotas del gasto (si es más de 1, se elige cómo te lo pagan). */
  installments: number;
  value: SplitState;
  onChange: (s: SplitState) => void;
  /** Sin el interruptor (siempre prendido): para dividir un gasto ya cargado. */
  alwaysOn?: boolean;
  /** Nombre del gasto: ofrece "dividir siempre así los gastos de …". */
  alwaysLabel?: string;
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
  const { amounts, error } = splitPayload(totalAmount, value, installments);
  const others = r2(amounts.reduce((s, a) => s + a, 0));
  const mine = r2(totalAmount - others);
  // En cuotas, todo se ve (y los montos se escriben) por cuota.
  const k = perCuota(value, installments) ? installments : 1;
  const per = (n: number) => r2(n / k);
  const perLabel = k > 1 ? " por cuota" : "";

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
      {!alwaysOn && (
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="split-on" className="flex items-center gap-1.5 text-sm">
              <Users className="size-4" /> Dividirlo con otras personas
            </Label>
            <p className="text-xs text-muted-foreground">Le asignás una parte (% o monto) a cada uno.</p>
          </div>
          <Switch id="split-on" checked={value.enabled} onCheckedChange={(v) => set({ enabled: v })} />
        </div>
      )}

      {(alwaysOn || value.enabled) && (
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
                  {amounts[i] > 0 && ` · ${formatMoney(per(amounts[i]), currency)}${perLabel}`}
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
                            : num(t === "amount" ? per(amounts[i]) : r2((amounts[i] / (totalAmount || 1)) * 100)),
                      })
                    }
                    className={`h-7 rounded px-2 text-xs font-medium ${p.shareType === t ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  >
                    {t === "percent" ? "%" : `${currency === "USD" ? "US$" : "$"}${k > 1 ? "/cuota" : ""}`}
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
                    onClick={() => {
                      if (o.v === value.mode) return;
                      // Los montos fijos se escriben por cuota en "en cuotas" y por el total en "todo junto".
                      const factor = o.v === "installments" ? 1 / installments : installments;
                      set({
                        mode: o.v,
                        people: value.people.map((p) =>
                          p.shareType === "amount" && parseAmount(p.input) > 0
                            ? { ...p, input: num(r2(parseAmount(p.input) * factor)) }
                            : p,
                        ),
                      });
                    }}
                    className={`h-8 rounded-md text-xs font-medium ${value.mode === o.v ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {value.people.length > 0 && alwaysLabel?.trim() && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-background p-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-brand"
                checked={!!value.always}
                onChange={(e) => set({ always: e.target.checked })}
              />
              <span>
                <span className="font-medium">Dividir siempre así</span> los gastos de «{alwaysLabel.trim()}»: los
                próximos (y los estimados) se dividen solos.
              </span>
            </label>
          )}

          {value.people.length > 0 && totalAmount > 0 && (
            <div className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
              {error ?? (
                <>
                  Te toca a vos: <span className="font-semibold text-foreground">{formatMoney(per(mine), currency)}{perLabel}</span>
                  {k > 1 && ` (total ${formatMoney(mine, currency)})`}
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
