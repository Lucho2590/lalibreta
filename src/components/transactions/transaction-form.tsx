"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight } from "lucide-react";
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
import { formatMoney, formatMonth, parseAmount } from "@/lib/format";
import type { Currency, TransactionKind } from "@/lib/domain/types";
import { accountCurrencies } from "@/lib/domain/types";
import { updateAccount } from "@/lib/domain/accounts";
import { useUsdRate } from "@/hooks/use-usd-rate";
import { ExchangeForm } from "./exchange-form";
import { ShareSection, type ShareSplit } from "./share-section";
import { buildParticipantsList, createSharedExpense } from "@/lib/domain/shared";
import { upsertContact } from "@/lib/domain/contacts";
import { apiFetch } from "@/lib/api";

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
  /** Con quiénes dividirlo (arranca con "Compartirlo" prendido). */
  shareWith?: ShareSplit[];
}

export interface SavedTransactionInfo {
  transactionId: string;
  amount: number;
  currency: Currency;
  sharedExpenseId: string | null;
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
      ) : (
        <MovementForm kind={mode} initial={initial} onSubmitted={onSubmitted} onSaved={onSaved} />
      )}
    </div>
  );
}

function MovementForm({
  kind,
  initial,
  onSubmitted,
  onSaved,
}: {
  kind: TransactionKind;
  initial?: TransactionFormInitial;
  onSubmitted?: () => void;
  /** Se llama con el gasto/ingreso guardado (no con transferencias). */
  onSaved?: (info: SavedTransactionInfo) => void | Promise<void>;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const [submitting, setSubmitting] = useState(false);
  const [shareEnabled, setShareEnabled] = useState(!!initial?.shareWith?.length);
  const [shareSplits, setShareSplits] = useState<ShareSplit[]>(initial?.shareWith ?? []);
  const [currency, setCurrency] = useState<Currency>(initial?.currency ?? "ARS");
  const [toCurrency, setToCurrency] = useState<Currency>("ARS");
  const [rateInput, setRateInput] = useState("");
  const usdRate = useUsdRate();

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
  const toAccountId = form.watch("toAccountId");
  const dateStr = form.watch("date");
  const installments = form.watch("installments");
  const cardClosed = form.watch("cardClosedAtPurchase");

  const account = accounts.find((a) => a.id === accountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);
  const isCredit = account?.type === "credit" && kind === "expense";
  const isTransfer = kind === "transfer";
  const isCardPayment = isTransfer && toAccount?.type === "credit";

  // Monedas posibles según la cuenta elegida (las tarjetas aceptan $ y US$).
  const fromCurrencies: Currency[] = account ? accountCurrencies(account) : ["ARS", "USD"];
  const toCurrencies: Currency[] = toAccount ? accountCurrencies(toAccount) : ["ARS", "USD"];
  const effCurrency: Currency = fromCurrencies.includes(currency) ? currency : fromCurrencies[0];
  // Transferencias: la misma moneda de un lado y del otro (los cambios van en
  // la pestaña Cambio). Solo el pago de una tarjeta puede cancelar deuda en
  // otra moneda (ej. pagar la parte en dólares con pesos).
  const effToCurrency: Currency = isCardPayment
    ? toCurrencies.includes(toCurrency)
      ? toCurrency
      : toCurrencies[0]
    : effCurrency;
  // Destino sin esa moneda (ej. pasar dólares a Mercado Pago, que solo tenía pesos):
  // se le agrega al guardar. Las cobachas son de una sola moneda: ahí no.
  const toMissingCurrency =
    isTransfer && !!toAccount && !isCardPayment && !accountCurrencies(toAccount).includes(effCurrency);
  const isExchange = isCardPayment && effToCurrency !== effCurrency;
  const rate = parseAmount(rateInput) || usdRate?.rate || 0;
  const amountValue = Number(form.watch("amount")) || 0;
  const exchangedAmount =
    isExchange && rate > 0
      ? Math.round((effCurrency === "USD" ? amountValue * rate : amountValue / rate) * 100) / 100
      : null;

  const selectableAccounts = accounts.filter((a) => a.active !== false);
  // Destinos: las otras cuentas (para cambiar de moneda está la pestaña Cambio).
  const transferTargets = selectableAccounts.filter((a) => a.id !== accountId);
  const filteredCategories = categories.filter(
    (c) => c.kind === (kind === "transfer" ? "expense" : kind),
  );

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

      if (values.kind === "transfer") {
        if (!values.toAccountId) {
          toast.error("Elegí la cuenta destino");
          return;
        }
        if (values.toAccountId === values.accountId) {
          toast.error("Elegí otra cuenta de destino");
          return;
        }
        if (toMissingCurrency && toAccount) {
          if (toAccount.type === "reserve") {
            toast.error(`${toAccount.name} es una cobacha en ${effCurrency === "USD" ? "pesos" : "dólares"}`);
            return;
          }
          await updateAccount(user.uid, toAccount.id, {
            currencies: [...accountCurrencies(toAccount), effCurrency],
          });
        }
        if (isExchange && !(rate > 0)) {
          toast.error("Falta la cotización");
          return;
        }
        const sourceAccount = accounts.find((a) => a.id === values.accountId);
        if (!sourceAccount) {
          toast.error("Cuenta origen no encontrada");
          return;
        }
        await createTransactionWithInstallments(user.uid, sourceAccount, {
          accountId: values.accountId,
          toAccountId: values.toAccountId,
          categoryId: "",
          description: values.description ?? "",
          totalAmount: values.amount,
          purchaseDate,
          kind: "transfer",
          installments: 1,
          cardClosedAtPurchase: false,
          currency: effCurrency,
          ...(isExchange && exchangedAmount != null
            ? { toCurrency: effToCurrency, toAmount: exchangedAmount, rate }
            : {}),
          transferType:
            toAccount?.type === "credit" ? "card-payment" : isExchange ? "exchange" : "transfer",
        });
        toast.success(
          toAccount?.type === "credit"
            ? "Pago de tarjeta registrado"
            : "Transferencia registrada",
        );
      } else {
        if (!account) {
          toast.error("Elegí una cuenta");
          return;
        }
        if (!values.categoryId) {
          toast.error("Elegí una categoría");
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
        let sharedExpenseId: string | null = null;

        // Si activó "Compartirlo", crear el SharedExpense + invitar.
        const sumOthers = shareSplits.reduce((s, x) => s + x.percentage, 0);
        if (
          shareEnabled &&
          effCurrency === "ARS" &&
          values.kind === "expense" &&
          shareSplits.length > 0 &&
          sumOthers > 0 &&
          sumOthers <= 100
        ) {
          try {
            const ownerPct = 100 - sumOthers;
            const participants = buildParticipantsList({
              owner: {
                uid: user.uid,
                email: user.email ?? "",
                displayName: user.displayName ?? null,
                percentage: ownerPct,
              },
              others: shareSplits.map((s) => ({
                uid: s.uid,
                email: s.email,
                displayName: s.displayName,
                percentage: s.percentage,
              })),
              totalAmount: values.amount,
            });
            const sharedId = await createSharedExpense({
              ownerUid: user.uid,
              ownerEmail: user.email ?? "",
              ownerDisplayName: user.displayName ?? null,
              description: values.description ?? "",
              totalAmount: values.amount,
              date: purchaseDate,
              ownerTransactionId: txId,
              participants,
            });
            sharedExpenseId = sharedId;
            toast.success(
              `Gasto compartido con ${shareSplits.length} ${
                shareSplits.length === 1 ? "persona" : "personas"
              }`,
            );
            // Guardar como contacto los splits que lo pidieron (best-effort).
            const toSave = shareSplits.filter((s) => s.saveAsContact);
            if (toSave.length > 0) {
              Promise.allSettled(
                toSave.map((s) =>
                  upsertContact(user.uid, {
                    email: s.email,
                    displayName: s.displayName,
                  }),
                ),
              ).catch((err) => console.warn("[upsertContact] error", err));
            }
            // Disparamos invitación por mail (best effort).
            apiFetch("/api/shared/invite", {
              method: "POST",
              body: JSON.stringify({ sharedExpenseId: sharedId }),
            })
              .then(async (r) => {
                const data = (await r.json()) as {
                  sent?: Array<{ email: string; ok: boolean; error?: string; loggedOnly?: boolean }>;
                  error?: string;
                };
                console.log("[shared invite] respuesta", data);
                if (!r.ok) {
                  toast.error(`Falló la invitación: ${data.error ?? r.status}`);
                  return;
                }
                const sent = data.sent ?? [];
                const ok = sent.filter((x) => x.ok).length;
                const fail = sent.filter((x) => !x.ok);
                if (fail.length > 0) {
                  toast.error(
                    `Mails: ${ok} ok, ${fail.length} con error. Detalle en consola.`,
                  );
                  for (const f of fail) {
                    console.warn("[shared invite] fallo:", f.email, f.error);
                  }
                } else if (sent.some((x) => x.loggedOnly)) {
                  toast.message(
                    `Mails logueados a consola (${ok}). Para envío real, configurá Resend o EMAIL_DEV_LOG.`,
                  );
                } else if (ok > 0) {
                  toast.success(`${ok} ${ok === 1 ? "invitación enviada" : "invitaciones enviadas"}`);
                }
              })
              .catch((err) => {
                console.warn("[shared invite] error", err);
                toast.error("No se pudo enviar la invitación");
              });
          } catch (err) {
            console.error(err);
            toast.error("Gasto guardado pero falló crear el compartido");
          }
        }
        try {
          await onSaved?.({ transactionId: txId, amount: values.amount, currency: effCurrency, sharedExpenseId });
        } catch (err) {
          console.error("[TransactionForm] onSaved", err);
        }
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
          {...form.register("amount", { setValueAs: parseAmount })}
        />
        {form.formState.errors.amount && (
          <p className="text-xs text-destructive">{form.formState.errors.amount.message}</p>
        )}
        {fromCurrencies.length > 1 && (
          <CurrencyToggle value={effCurrency} options={fromCurrencies} onChange={setCurrency} />
        )}
      </div>

      {isTransfer ? (
        <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label>De cuenta</Label>
            <Select
              value={accountId}
              onValueChange={(v) =>
                form.setValue("accountId", v ?? "", { shouldValidate: true })
              }
            >
              <SelectTrigger className="h-12 w-full">
                <SelectValue
                  placeholder="Cuenta origen"
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

          <div className="flex justify-center">
            <ArrowRight className="size-5 text-muted-foreground" />
          </div>

          <div className="space-y-1">
            <Label>A cuenta</Label>
            <Select
              value={toAccountId}
              onValueChange={(v) =>
                form.setValue("toAccountId", v ?? "", { shouldValidate: true })
              }
            >
              <SelectTrigger className="h-12 w-full">
                <SelectValue
                  placeholder="Cuenta destino"
                  items={transferTargets.map((a) => ({
                    value: a.id,
                    label: a.name,
                  }))}
                />
              </SelectTrigger>
              <SelectContent>
                {transferTargets.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isCardPayment && toCurrencies.length > 1 && (
              <>
                <p className="mt-1.5 text-xs text-muted-foreground">¿Qué parte de la tarjeta pagás?</p>
                <CurrencyToggle value={effToCurrency} options={toCurrencies} onChange={setToCurrency} />
              </>
            )}
            {toMissingCurrency && toAccount && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {toAccount.type === "reserve"
                  ? `${toAccount.name} no maneja ${effCurrency === "USD" ? "dólares" : "pesos"}.`
                  : `${toAccount.name} no tenía ${effCurrency === "USD" ? "dólares" : "pesos"}: se los agrego al guardar.`}
              </p>
            )}
          </div>

          {isExchange && (
            <div className="space-y-2 rounded-lg bg-background p-3">
              <div className="space-y-1">
                <Label htmlFor="rate">Cotización ($ por US$)</Label>
                <Input
                  id="rate"
                  inputMode="decimal"
                  className="h-11"
                  placeholder={usdRate ? String(usdRate.rate) : "Ej: 1480"}
                  value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                />
                {usdRate && !rateInput && (
                  <p className="text-xs text-muted-foreground">
                    Oficial BCRA del {usdRate.date.split("-").reverse().join("/")}. Si cambiaste a otro
                    valor, escribilo.
                  </p>
                )}
              </div>
              {exchangedAmount != null && amountValue > 0 && (
                <p className="text-sm">
                  {formatMoney(amountValue, effCurrency)} →{" "}
                  <span className="font-semibold">{formatMoney(exchangedAmount, effToCurrency)}</span>
                </p>
              )}
            </div>
          )}
          {toAccount?.type === "credit" && (
            <p className="text-xs text-muted-foreground">Se registra como pago de la tarjeta.</p>
          )}
        </div>
      ) : (
        <>
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
        </>
      )}

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

      {kind === "expense" && effCurrency === "ARS" && (
        <ShareSection
          totalAmount={form.watch("amount") || 0}
          enabled={shareEnabled}
          onEnabledChange={setShareEnabled}
          splits={shareSplits}
          onSplitsChange={setShareSplits}
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
