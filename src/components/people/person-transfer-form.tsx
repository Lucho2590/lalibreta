"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccounts, usePeople } from "@/hooks/use-data";
import { apiPost, errorText } from "@/lib/api";
import { sortAccounts } from "@/lib/domain/accounts";
import type { PersonRef } from "@/lib/domain/people";
import type { Currency } from "@/lib/domain/types";
import { accountCurrencies, userCurrencies } from "@/lib/domain/types";
import { currencySymbol, formatAmountInput, formatMoney, parseAmount } from "@/lib/format";

export type PersonDirection = "out" | "in" | "loan";

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const num = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);

const DIRECTIONS: Array<{ value: PersonDirection; label: string }> = [
  { value: "in", label: "Me pasó / me pagó" },
  { value: "out", label: "Le pasé / le pagué" },
  { value: "loan", label: "Le presté" },
];

/**
 * Plata con una persona: le pasé, me pasó o le presté. No es ingreso ni
 * gasto: mueve el saldo de mi cuenta y lo que nos debemos. Si la persona usa
 * la app, la tiene que confirmar (y elige su cuenta).
 */
export function PersonTransferForm({
  defaultPerson,
  defaultDirection = "in",
  defaultAmount,
  defaultCurrency = "ARS",
  onSubmitted,
}: {
  defaultPerson?: PersonRef;
  defaultDirection?: PersonDirection;
  defaultAmount?: number;
  defaultCurrency?: Currency;
  onSubmitted?: () => void;
}) {
  const { data: accounts } = useAccounts();
  const { data: people } = usePeople();
  const [person, setPerson] = useState<string>(defaultPerson ?? "");
  const [direction, setDirection] = useState<PersonDirection>(defaultDirection);
  const [accountId, setAccountId] = useState("");
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [amountInput, setAmountInput] = useState(defaultAmount ? num(defaultAmount) : "");
  const [date, setDate] = useState(todayLocal);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const usable = useMemo(
    () => sortAccounts(accounts.filter((a) => a.active !== false && a.type !== "credit")),
    [accounts],
  );
  const options = usable.filter((a) => a.type !== "reserve" || accountCurrencies(a).includes(currency));
  const account =
    options.find((a) => a.id === accountId) ??
    options.find((a) => a.isMain && accountCurrencies(a).includes(currency)) ??
    options.find((a) => accountCurrencies(a).includes(currency)) ??
    options[0];
  const who = people.find((p) => p.ref === person);
  const amount = parseAmount(amountInput) || 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!who) return toast.error("Elegí la persona");
    if (!account) return toast.error("Elegí la cuenta");
    if (!(amount > 0)) return toast.error("Ingresá un monto");
    setBusy(true);
    try {
      const r = await apiPost<{ status: string; name: string }>("/api/people/transfers", {
        person: who.ref,
        direction: direction === "in" ? "in" : "out",
        kind: direction === "loan" ? "loan" : "payment",
        accountId: account.id,
        amount,
        currency,
        date,
        description: description.trim() || undefined,
      });
      toast.success(
        r.status === "pending"
          ? `Listo. ${r.name} lo tiene que confirmar`
          : `Anotado: ${formatMoney(amount, currency)} ${direction === "in" ? `de ${r.name}` : `a ${r.name}`}`,
      );
      onSubmitted?.();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (people.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
        Todavía no tenés a nadie. Conectate con alguien o agregá una persona sin la app desde{" "}
        <Link href="/contactos" className="font-medium underline">
          Contactos
        </Link>
        .
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <Label>Persona</Label>
        <Select value={person} onValueChange={(v) => setPerson(v ?? "")}>
          <SelectTrigger className="h-12 w-full">
            <SelectValue placeholder="Elegí a quién" items={people.map((p) => ({ value: p.ref, label: p.name }))} />
          </SelectTrigger>
          <SelectContent>
            {people.map((p) => (
              <SelectItem key={p.ref} value={p.ref}>
                {p.name}
                <span className="text-muted-foreground"> · {p.isApp ? "en la app" : "sin app"}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
        {DIRECTIONS.map((d) => (
          <button
            key={d.value}
            type="button"
            onClick={() => setDirection(d.value)}
            className={`h-9 rounded-lg text-xs font-medium transition ${direction === d.value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="pt-amount">Monto</Label>
          <Input
            id="pt-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-12 text-lg"
            placeholder="0"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            onBlur={(e) => setAmountInput(formatAmountInput(e.target.value))}
          />
        </div>
        <div className="inline-flex min-h-12 flex-wrap rounded-lg bg-muted p-1">
          {userCurrencies(usable).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              className={`rounded-md px-3 text-xs font-medium ${currency === c ? "bg-background shadow-sm" : "text-muted-foreground"}`}
            >
              {currencySymbol(c)}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label>{direction === "in" ? "Entró en" : "Salió de"}</Label>
        <Select value={account?.id ?? ""} onValueChange={(v) => setAccountId(v ?? "")}>
          <SelectTrigger className="h-12 w-full">
            <SelectValue placeholder="Elegí la cuenta" items={options.map((a) => ({ value: a.id, label: a.name }))} />
          </SelectTrigger>
          <SelectContent>
            {options.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="pt-date">Fecha</Label>
          <Input id="pt-date" type="date" className="h-11" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pt-desc">Detalle</Label>
          <Input id="pt-desc" className="h-11" placeholder="Opcional" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        No es ingreso ni gasto: mueve el saldo de tu cuenta y lo que se deben.
        {who?.isApp && ` ${who.name.split(" ")[0]} lo tiene que confirmar y elegir su cuenta.`}
      </p>

      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={busy}>
        {busy ? "Guardando…" : "Registrar"}
      </Button>
    </form>
  );
}
