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
import { formatMonth } from "@/lib/format";
import type { TransactionKind } from "@/lib/domain/types";
import { ShareSection, type ShareSplit } from "./share-section";
import { buildParticipantsList, createSharedExpense } from "@/lib/domain/shared";
import { apiFetch } from "@/lib/api";

const schema = z.object({
  kind: z.enum(["expense", "income", "transfer"]),
  amount: z.number().positive("El monto debe ser mayor a 0"),
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

export function TransactionForm({
  defaultKind = "expense",
  onSubmitted,
}: {
  defaultKind?: TransactionKind;
  onSubmitted?: () => void;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const [submitting, setSubmitting] = useState(false);
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareSplits, setShareSplits] = useState<ShareSplit[]>([]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const resolver = zodResolver(schema as never) as unknown as Resolver<FormValues>;
  const form = useForm<FormValues>({
    resolver,
    defaultValues: {
      kind: defaultKind,
      amount: 0,
      accountId: "",
      toAccountId: "",
      categoryId: "",
      date: today,
      description: "",
      installments: 1,
      cardClosedAtPurchase: false,
    },
  });

  const kind = form.watch("kind");
  const accountId = form.watch("accountId");
  const toAccountId = form.watch("toAccountId");
  const dateStr = form.watch("date");
  const installments = form.watch("installments");
  const cardClosed = form.watch("cardClosedAtPurchase");

  const account = accounts.find((a) => a.id === accountId);
  const isCredit = account?.type === "credit" && kind === "expense";
  const isTransfer = kind === "transfer";

  const selectableAccounts = accounts.filter((a) => a.active !== false);
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
          toast.error("La cuenta origen y destino no pueden ser la misma");
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
        });
        toast.success("Transferencia registrada");
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
        });
        toast.success(values.kind === "income" ? "Ingreso guardado" : "Gasto guardado");

        // Si activó "Compartirlo", crear el SharedExpense + invitar.
        const sumOthers = shareSplits.reduce((s, x) => s + x.percentage, 0);
        if (
          shareEnabled &&
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
            toast.success(
              `Gasto compartido con ${shareSplits.length} ${
                shareSplits.length === 1 ? "persona" : "personas"
              }`,
            );
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
      <div className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1">
        {(
          [
            { value: "expense", label: "Gasto" },
            { value: "income", label: "Ingreso" },
            { value: "transfer", label: "Transfer." },
          ] as const
        ).map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => form.setValue("kind", opt.value)}
            className={`h-10 rounded-xl text-sm font-medium transition ${
              kind === opt.value ? "bg-background shadow-sm" : "text-muted-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <Label htmlFor="amount">Monto</Label>
        <Input
          id="amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          className="h-12 text-lg"
          {...form.register("amount", { valueAsNumber: true })}
        />
        {form.formState.errors.amount && (
          <p className="text-xs text-destructive">{form.formState.errors.amount.message}</p>
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
                  items={selectableAccounts
                    .filter((a) => a.id !== accountId)
                    .map((a) => ({ value: a.id, label: a.name }))}
                />
              </SelectTrigger>
              <SelectContent>
                {selectableAccounts
                  .filter((a) => a.id !== accountId)
                  .map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
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

      {kind === "expense" && (
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
