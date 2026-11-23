"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
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
import { currencyOptionLabel, parseAmount } from "@/lib/format";
import { accountCurrencies, type Currency } from "@/lib/domain/types";
import { recurringCollectionPath } from "@/lib/domain/recurring";
import { monthKey, type RecurringExpense, type Transaction, type TransactionKind } from "@/lib/domain/types";
import {
  installmentsCollectionPath,
  transactionsCollectionPath,
  updateTransaction,
} from "@/lib/domain/installments";
import { apiPost } from "@/lib/api";

/** Nombres que son claramente un cobro, no un gasto. */
const INCOME_WORDS = /\b(sueldo|salario|honorarios?|aguinaldo|cobro|freelance|jubilacion|pension)\b/;

export function RecurringForm({
  onCreated,
  initial,
  viewMonth,
}: {
  onCreated?: () => void;
  /** Editar un fijo existente. */
  initial?: RecurringExpense;
  /** Mes que se está mirando (YYYY-MM): si ese mes ya se cargó, se ofrece actualizarlo también. */
  viewMonth?: string;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();

  const today = useMemo(() => new Date(), []);
  const currentMonth = monthKey(today.getFullYear(), today.getMonth() + 1);

  const [kind, setKind] = useState<TransactionKind>(initial?.kind ?? "expense");
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(
    initial ? new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(initial.amount) : "",
  );
  const [currency, setCurrency] = useState<Currency>(initial?.currency ?? "ARS");
  const [accountId, setAccountId] = useState(initial?.accountId ?? "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? "");
  const [day, setDay] = useState(initial?.dayOfMonth ?? 1);
  const [start, setStart] = useState(initial?.startMonth ?? currentMonth);
  const [end, setEnd] = useState(initial?.endMonth ?? "");
  // Editando: el del mes que se mira, si ya se cargó (para actualizarlo también).
  const [appliedTxId, setAppliedTxId] = useState<string | null>(null);
  const [updateApplied, setUpdateApplied] = useState(true);
  useEffect(() => {
    if (!user || !initial || !viewMonth) return;
    getDocs(
      query(
        collection(db, installmentsCollectionPath(user.uid)),
        where("recurringId", "==", initial.id),
        where("paymentMonth", "==", viewMonth),
      ),
    ).then((snap) => setAppliedTxId((snap.docs[0]?.data().transactionId as string | undefined) ?? null));
  }, [user, initial, viewMonth]);
  const [busy, setBusy] = useState(false);

  const selectableAccounts = accounts.filter((a) => a.active !== false);
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const currencyOptions: Currency[] = selectedAccount ? accountCurrencies(selectedAccount) : ["ARS", "USD"];
  const effCurrency: Currency = currencyOptions.includes(currency) ? currency : currencyOptions[0];
  const filteredCategories = categories.filter((c) => c.kind === kind);
  const [autoKind, setAutoKind] = useState(false);

  // Al escribir el nombre: si coincide con una categoría ("Sueldo", "Alquiler"),
  // se elige esa categoría y su tipo; si suena a cobro (sueldo, honorarios…),
  // pasa a ingreso fijo. Así un "Sueldo" no termina cargado como gasto.
  const onNameChange = (value: string) => {
    setName(value);
    const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    const match = categories.find((c) => norm(c.name) === norm(value));
    if (match) {
      if (match.kind !== kind) setAutoKind(true);
      setKind(match.kind);
      setCategoryId(match.id);
      return;
    }
    if (kind === "expense" && INCOME_WORDS.test(norm(value))) {
      setKind("income");
      setCategoryId("");
      setAutoKind(true);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseAmount(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Monto inválido (ej. 12.500,50)");
      return;
    }
    if (!user || !name.trim() || !accountId || !categoryId) return;
    setBusy(true);
    try {
      if (initial) {
        await updateDoc(doc(db, recurringCollectionPath(user.uid), initial.id), {
          name: name.trim(),
          amount: amt,
          currency: effCurrency,
          accountId,
          categoryId,
          kind,
          dayOfMonth: Math.min(31, Math.max(1, day)),
          startMonth: start,
          endMonth: end || null,
        });
        // El de este mes ya estaba cargado: se actualiza también (y su reparto, si está dividido).
        if (appliedTxId && updateApplied && selectedAccount) {
          const snap = await getDoc(doc(db, transactionsCollectionPath(user.uid), appliedTxId));
          if (snap.exists()) {
            const t = snap.data() as Omit<Transaction, "id">;
            await updateTransaction(user.uid, selectedAccount, appliedTxId, {
              accountId,
              categoryId,
              description: name.trim(),
              totalAmount: amt,
              purchaseDate: t.purchaseDate.toDate(),
              kind: kind === "income" ? "income" : "expense",
              installments: 1,
              currency: effCurrency,
              recurringId: initial.id,
            });
            await apiPost("/api/splits/resync", { txIds: [appliedTxId] }).catch(() => {});
          }
        }
        toast.success("Fijo actualizado");
        onCreated?.();
        return;
      }
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
          onClick={() => {
            setKind("expense");
            setAutoKind(false);
          }}
          className={`h-10 rounded-xl text-sm font-medium transition ${
            kind === "expense" ? "bg-background shadow-sm" : "text-muted-foreground"
          }`}
        >
          Gasto fijo
        </button>
        <button
          type="button"
          onClick={() => {
            setKind("income");
            setAutoKind(false);
          }}
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
          onChange={(e) => onNameChange(e.target.value)}
        />
        {autoKind && (
          <p className="text-xs text-muted-foreground">
            Lo pasé a {kind === "income" ? "ingreso" : "gasto"} fijo. Si no es así, cambialo arriba.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="r-amount">Monto</Label>
        <Input
          id="r-amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          className="h-12 text-lg"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {currencyOptions.length > 1 && (
          <div className="mt-1.5 inline-flex flex-wrap rounded-lg bg-muted p-0.5">
            {currencyOptions.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                className={`h-8 rounded-md px-3 text-xs font-medium transition ${
                  effCurrency === c ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                {currencyOptionLabel(c)}
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

      {initial && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
          <p>El cambio vale de acá en adelante: lo que ya se cargó en otros meses no cambia.</p>
          {appliedTxId && viewMonth && (
            <label className="flex cursor-pointer items-center gap-2 text-foreground">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                checked={updateApplied}
                onChange={(e) => setUpdateApplied(e.target.checked)}
              />
              Actualizar también el de este mes ({viewMonth.split("-").reverse().join("/")}), que ya está cargado
            </label>
          )}
        </div>
      )}

      <Button
        type="submit"
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        disabled={busy || !name.trim() || !amount || !accountId || !categoryId}
      >
        {busy ? "Guardando…" : initial ? "Guardar cambios" : "Guardar"}
      </Button>
    </form>
  );
}
