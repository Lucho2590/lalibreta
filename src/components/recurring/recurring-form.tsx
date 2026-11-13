"use client";

import { useMemo, useState } from "react";
import {
  Timestamp,
  addDoc,
  collection,
} from "firebase/firestore";
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
import { useAuth } from "@/hooks/use-auth";
import { useAccounts, useCategories } from "@/hooks/use-data";
import { db } from "@/lib/firebase/client";
import { accountCurrencies, type Currency } from "@/lib/domain/types";
import { recurringCollectionPath } from "@/lib/domain/recurring";
import { monthKey, type TransactionKind } from "@/lib/domain/types";

export function RecurringForm({ onCreated }: { onCreated?: () => void }) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();

  const today = useMemo(() => new Date(), []);
  const currentMonth = monthKey(today.getFullYear(), today.getMonth() + 1);

  const [kind, setKind] = useState<TransactionKind>("expense");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("ARS");
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [day, setDay] = useState(1);
  const [start, setStart] = useState(currentMonth);
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);

  const selectableAccounts = accounts.filter((a) => a.active !== false);
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const currencyOptions: Currency[] = selectedAccount ? accountCurrencies(selectedAccount) : ["ARS", "USD"];
  const effCurrency: Currency = currencyOptions.includes(currency) ? currency : currencyOptions[0];
  const filteredCategories = categories.filter((c) => c.kind === kind);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(amount);
    if (!user || !name.trim() || !accountId || !categoryId || !amt) return;
    setBusy(true);
    try {
      await addDoc(collection(db, recurringCollectionPath(user.uid)), {
        name: name.trim(),
        amount: amt,
        currency: effCurrency,
        accountId,
        categoryId,
        kind,
        dayOfMonth: Math.min(31, Math.max(1, day)),
        startMonth: start,
        endMonth: end || null,
        active: true,
        createdAt: Timestamp.now(),
      });
      toast.success(kind === "income" ? "Ingreso fijo creado" : "Gasto fijo creado");
      setName("");
      setAmount("");
      onCreated?.();
    } catch (err) {
      toast.error("No se pudo crear");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-2 rounded-2xl bg-muted p-1">
        <button
          type="button"
          onClick={() => setKind("expense")}
          className={`h-10 rounded-xl text-sm font-medium transition ${
            kind === "expense" ? "bg-background shadow-sm" : "text-muted-foreground"
          }`}
        >
          Gasto fijo
        </button>
        <button
          type="button"
          onClick={() => setKind("income")}
          className={`h-10 rounded-xl text-sm font-medium transition ${
            kind === "income" ? "bg-background shadow-sm" : "text-muted-foreground"
          }`}
        >
          Ingreso fijo
        </button>
      </div>

      <div className="space-y-1">
        <Label htmlFor="r-name">Nombre</Label>
        <Input
          id="r-name"
          className="h-12"
          placeholder="Ej: Alquiler, Internet, Sueldo"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="r-amount">Monto</Label>
        <Input
          id="r-amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          className="h-12 text-lg"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {currencyOptions.length > 1 && (
          <div className="mt-1.5 inline-flex rounded-lg bg-muted p-0.5">
            {currencyOptions.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                className={`h-8 rounded-md px-3 text-xs font-medium transition ${
                  effCurrency === c ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                {c === "ARS" ? "$ Pesos" : "US$ Dólares"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <Label>Cuenta</Label>
        <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "")}>
          <SelectTrigger className="h-12 w-full">
            <SelectValue
              placeholder="Elegí una cuenta"
              items={selectableAccounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          </SelectTrigger>
          <SelectContent>
            {selectableAccounts.map((acc) => (
              <SelectItem key={acc.id} value={acc.id}>
                {acc.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label>Categoría</Label>
        {filteredCategories.length === 0 ? (
          <a
            href="/categorias"
            className="block rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground hover:bg-muted/40"
          >
            No tenés categorías de {kind === "income" ? "ingreso" : "gasto"}.
            <br />
            <span className="font-medium underline">Crear una</span>
          </a>
        ) : (
          <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? "")}>
            <SelectTrigger className="h-12 w-full">
              <SelectValue
                placeholder="Elegí una categoría"
                items={filteredCategories.map((c) => ({ value: c.id, label: c.name }))}
              />
            </SelectTrigger>
            <SelectContent>
              {filteredCategories.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="r-day">Día de cargo</Label>
        <Input
          id="r-day"
          type="number"
          inputMode="numeric"
          min={1}
          max={31}
          className="h-12"
          value={day}
          onChange={(e) => setDay(Number(e.target.value) || 1)}
        />
        <p className="text-xs text-muted-foreground">
          Si el mes es más corto, se aplica el último día disponible.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="r-start" className="text-xs">
            Desde
          </Label>
          <Input
            id="r-start"
            type="month"
            className="h-11"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-end" className="text-xs">
            Hasta (opcional)
          </Label>
          <Input
            id="r-end"
            type="month"
            className="h-11"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>

      <Button
        type="submit"
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        disabled={busy || !name.trim() || !amount || !accountId || !categoryId}
      >
        {busy ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}
