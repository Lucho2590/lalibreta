"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
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
import { useAccounts, useCategories } from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { createTransactionWithInstallments } from "@/lib/domain/installments";
import { computeFirstBillingMonth } from "@/lib/domain/cycles";
import { formatAmountInput, formatMonth, parseAmount } from "@/lib/format";
import type { Currency, TransactionKind } from "@/lib/domain/types";
import { accountCurrencies } from "@/lib/domain/types";
import { ExchangeForm } from "./exchange-form";
import { TransferForm } from "./transfer-form";
import { PersonTransferForm } from "@/components/people/person-transfer-form";
import { SplitSection, emptySplit, splitPayload, type SplitState } from "./split-section";
import { userRef } from "@/lib/domain/people";
import { apiPost, errorText } from "@/lib/api";

const schema = z.object({
  kind: z.enum(["expense", "income", "transfer"]),
  amount: z.number({ error: "Ingresá un monto válido (ej. 12.500,50)" }).positive("El monto debe ser mayor a 0"),
  accountId: z.string().min(1, "Elegí una cuenta"),
  toAccountId: z.string(),
  categoryId: z.string(),
  date: z.string().min(1, "Elegí la fecha"),
  description: z.string().max(200),
  installments: z.number().int().min(1).max(36),
  cardClosedAtPurchase: z.boolean(),
});

type FormValues = z.input<typeof schema>;

const INSTALLMENT_OPTIONS = [1, 3, 6, 9, 12, 18, 24];

/** Valores para abrir el formulario precargado (ej. el gasto de una actividad de la agenda). */
export interface TransactionFormInitial {
  description?: string;
  /** "YYYY-MM-DD" */
  date?: string;
  amount?: number | null;
  currency?: Currency | null;
  /** Con quiénes dividirlo (arranca con "Dividirlo" prendido, en partes iguales). */
  splitWith?: Array<{ uid: string; name: string }>;
}

export interface SavedTransactionInfo {
  transactionId: string;
  amount: number;
  currency: Currency;
  /** Si se dividió con otras personas: splits/{id}. */
  splitId: string | null;
}

/** Pestañas del formulario: los tipos de movimiento + cambio de dólares. */
export type FormMode = TransactionKind | "exchange";

const MODES: Array<{ value: FormMode; label: string }> = [
  { value: "expense", label: "Gasto" },
  { value: "income", label: "Ingreso" },
  { value: "transfer", label: "Transferir" },
  { value: "exchange", label: "Cambio" },
];

export function TransactionForm({
  defaultKind = "expense",
  initial,
  onSubmitted,
  onSaved,
}: {
  defaultKind?: FormMode;
  initial?: TransactionFormInitial;
  onSubmitted?: () => void;
  /** Se llama con el gasto/ingreso guardado (no con transferencias). */
  onSaved?: (info: SavedTransactionInfo) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<FormMode>(defaultKind);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-1 rounded-2xl bg-muted p-1">
        {MODES.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setMode(opt.value)}
            className={`h-10 rounded-xl text-sm font-medium transition ${
              mode === opt.value ? "bg-background shadow-sm" : "text-muted-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {mode === "exchange" ? (
        <ExchangeForm onSubmitted={onSubmitted} />
      ) : mode === "transfer" ? (
        <TransferTabs onSubmitted={onSubmitted} />
      ) : (
        <MovementForm kind={mode} initial={initial} onSubmitted={onSubmitted} onSaved={onSaved} />
      )}
    </div>
  );
}

/** Transferir: entre mis cuentas o con una persona (le pasé / me pasó / le presté). */
function TransferTabs({ onSubmitted }: { onSubmitted?: () => void }) {
  const [withPerson, setWithPerson] = useState(false);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/60 p-1">
        {[
          { v: false, label: "Entre mis cuentas" },
          { v: true, label: "Con una persona" },
        ].map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => setWithPerson(o.v)}
            className={`h-9 rounded-lg text-sm font-medium transition ${withPerson === o.v ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {withPerson ? <PersonTransferForm onSubmitted={onSubmitted} /> : <TransferForm onSubmitted={onSubmitted} />}
    </div>
  );
}

function MovementForm({
  kind,
  initial,
  onSubmitted,
  onSaved,
}: {
  kind: "expense" | "income";
  initial?: TransactionFormInitial;
  onSubmitted?: () => void;
  /** Se llama con el gasto/ingreso guardado. */
  onSaved?: (info: SavedTransactionInfo) => void | Promise<void>;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const [submitting, setSubmitting] = useState(false);
  const [split, setSplit] = useState<SplitState>(() => {
    const people = initial?.splitWith ?? [];
    if (people.length === 0) return emptySplit();
    const each = Math.round((100 / (people.length + 1)) * 100) / 100;
    return {
      enabled: true,
      mode: "installments",
      people: people.map((p) => ({
        ref: userRef(p.uid),
        name: p.name,
        isApp: true,
        shareType: "percent" as const,
        input: new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(each),
      })),
    };
  });
  const [currency, setCurrency] = useState<Currency>(initial?.currency ?? "ARS");

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const resolver = zodResolver(schema as never) as unknown as Resolver<FormValues>;
  const form = useForm<FormValues>({
    resolver,
    defaultValues: {
      kind,
      amount: initial?.amount && initial.amount > 0 ? initial.amount : 0,
      accountId: "",
      toAccountId: "",
      categoryId: "",
      date: initial?.date ?? today,
      description: initial?.description ?? "",
      installments: 1,
      cardClosedAtPurchase: false,
    },
  });

  // La pestaña manda: mantenemos el valor del form sincronizado.
  useEffect(() => {
    form.setValue("kind", kind);
  }, [kind, form]);
  const accountId = form.watch("accountId");
  const dateStr = form.watch("date");
  const installments = form.watch("installments");
  const cardClosed = form.watch("cardClosedAtPurchase");

  const account = accounts.find((a) => a.id === accountId);
  const isCredit = account?.type === "credit" && kind === "expense";

  // Monedas posibles según la cuenta elegida (las tarjetas aceptan $ y US$).
  const fromCurrencies: Currency[] = account ? accountCurrencies(account) : ["ARS", "USD"];
  const effCurrency: Currency = fromCurrencies.includes(currency) ? currency : fromCurrencies[0];

  const selectableAccounts = accounts.filter((a) => a.active !== false);
  const filteredCategories = categories.filter((c) => c.kind === kind);

  useEffect(() => {
    if (!isCredit) form.setValue("installments", 1);
  }, [isCredit, form]);

  useEffect(() => {
    const current = form.getValues("categoryId");
    if (current && !filteredCategories.find((c) => c.id === current)) {
      form.setValue("categoryId", "");
    }
  }, [kind, filteredCategories, form]);

  const preview = useMemo(() => {
    if (!isCredit || !account || !dateStr) return null;
    const purchase = new Date(`${dateStr}T12:00:00`);
    const { year, month } = computeFirstBillingMonth(account, purchase, cardClosed);
    return formatMonth(year, month);
  }, [isCredit, account, dateStr, cardClosed]);

  const submit = form.handleSubmit(async (values) => {
    if (!user) return;
    setSubmitting(true);
    try {
      const purchaseDate = new Date(`${values.date}T12:00:00`);

      if (!account) {
        toast.error("Elegí una cuenta");
        return;
      }
      if (!values.categoryId) {
        toast.error("Elegí una categoría");
        return;
      }
      const splitting = values.kind === "expense" && split.enabled && split.people.length > 0;
      const payload = splitting ? splitPayload(values.amount, split) : null;
      if (payload?.error) {
        toast.error(payload.error);
        return;
      }
      const txId = await createTransactionWithInstallments(user.uid, account, {
        accountId: values.accountId,
        categoryId: values.categoryId,
        description: values.description ?? "",
        totalAmount: values.amount,
        purchaseDate,
        kind: values.kind,
        installments: values.installments,
        cardClosedAtPurchase: values.cardClosedAtPurchase,
        currency: effCurrency,
      });
      toast.success(values.kind === "income" ? "Ingreso guardado" : "Gasto guardado");
      let splitId: string | null = null;
      // Dividirlo: el server valida conexiones y avisa a cada uno.
      if (payload) {
        try {
          const r = await apiPost<{ id: string }>("/api/splits", {
            txId,
            mode: split.mode,
            participants: payload.participants,
          });
          splitId = r.id;
          const apps = split.people.filter((p) => p.isApp).length;
          toast.success(
            apps > 0
              ? `Dividido: ${apps === 1 ? "le llegó para aceptar" : `les llegó a ${apps} personas para aceptar`}`
              : "Dividido: queda anotado lo que te deben",
          );
          setSplit(emptySplit());
        } catch (err) {
          toast.error(`El gasto se guardó, pero no se pudo dividir: ${errorText(err)}`);
        }
      }
      try {
        await onSaved?.({ transactionId: txId, amount: values.amount, currency: effCurrency, splitId });
      } catch (err) {
        console.error("[TransactionForm] onSaved", err);
      }

      form.reset({ ...form.getValues(), amount: 0, description: "" });
      onSubmitted?.();
    } catch (err) {
      toast.error("No se pudo guardar");
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="amount">Monto</Label>
        <Input
          id="amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          className="h-12 text-lg"
          {...form.register("amount", {
            setValueAs: parseAmount,
            // Al salir del campo, el número prolijo: 74915.06 → 74.915,06.
            onBlur: (e) => {
              e.target.value = formatAmountInput(e.target.value);
            },
          })}
        />
        {form.formState.errors.amount && (
          <p className="text-xs text-destructive">{form.formState.errors.amount.message}</p>
        )}
        {fromCurrencies.length > 1 && (
          <CurrencyToggle value={effCurrency} options={fromCurrencies} onChange={setCurrency} />
        )}
      </div>

      <div className="space-y-1">
        <Label>Cuenta</Label>
        <Select
          value={accountId}
          onValueChange={(v) =>
            form.setValue("accountId", v ?? "", { shouldValidate: true })
          }
        >
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
          <Select
            value={form.watch("categoryId")}
            onValueChange={(v) =>
              form.setValue("categoryId", v ?? "", { shouldValidate: true })
            }
          >
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
        <Label htmlFor="date">Fecha</Label>
        <Input id="date" type="date" className="h-12" {...form.register("date")} />
      </div>

      <div className="space-y-1">
        <Label htmlFor="description">Descripción</Label>
        <Input
          id="description"
          className="h-12"
          placeholder="Opcional"
          {...form.register("description")}
        />
      </div>

      {isCredit && (
        <div className="rounded-lg border p-3 space-y-3 bg-muted/30">
          <div className="space-y-1">
            <Label>Cuotas</Label>
            <div className="flex flex-wrap gap-2">
              {INSTALLMENT_OPTIONS.map((n) => (
                <button
                  type="button"
                  key={n}
                  onClick={() => form.setValue("installments", n)}
                  className={`min-w-10 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                    installments === n
                      ? "border-transparent bg-brand text-brand-foreground"
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  {n}
                </button>
              ))}
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={36}
                className="h-9 w-20"
                value={installments}
                onChange={(e) =>
                  form.setValue("installments", Number(e.target.value) || 1)
                }
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="cardClosed" className="text-sm">
                ¿La tarjeta ya estaba cerrada?
              </Label>
              <p className="text-xs text-muted-foreground">
                Si activás esto, la primera cuota cae en el mes siguiente.
              </p>
            </div>
            <Switch
              id="cardClosed"
              checked={cardClosed}
              onCheckedChange={(v) => form.setValue("cardClosedAtPurchase", v)}
            />
          </div>

          {preview && (
            <p className="text-xs">
              Primer cargo en <span className="font-medium">{preview}</span>
              {installments > 1 && ` · ${installments} cuotas`}
            </p>
          )}
        </div>
      )}

      {kind === "expense" && (
        <SplitSection
          totalAmount={Number(form.watch("amount")) || 0}
          currency={effCurrency}
          installments={isCredit ? installments : 1}
          value={split}
          onChange={setSplit}
        />
      )}

      <Button
        type="submit"
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        disabled={submitting}
      >
        {submitting ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}

function CurrencyToggle({
  value,
  options,
  onChange,
}: {
  value: Currency;
  options: Currency[];
  onChange: (c: Currency) => void;
}) {
  return (
    <div className="mt-1.5 inline-flex rounded-lg bg-muted p-0.5">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`h-8 rounded-md px-3 text-xs font-medium transition ${
            value === c ? "bg-background shadow-sm" : "text-muted-foreground"
          }`}
        >
          {c === "ARS" ? "$ Pesos" : "US$ Dólares"}
        </button>
      ))}
    </div>
  );
}
