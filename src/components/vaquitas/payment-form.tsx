"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts } from "@/hooks/use-data";
import { useFxRates } from "@/hooks/use-fx-rates";
import { apiPost, errorText } from "@/lib/api";
import { sortAccounts } from "@/lib/domain/accounts";
import { accountCurrencies, type Currency } from "@/lib/domain/types";
import { crossRate, firstName, type Vaquita, type VaquitaPayment } from "@/lib/domain/vaquitas";
import { currencySymbol, formatAmountInput, formatMoney, parseAmount } from "@/lib/format";
import { Chip, CurrencyPicker, num, todayLocal } from "./shared";

const NO_ACCOUNT = "__none__";
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Registrar (o editar) un pago entre integrantes para saldar. */
export function VaquitaPaymentForm({
  vaquita: v,
  payment,
  defaults,
  onDone,
}: {
  vaquita: Vaquita;
  payment?: VaquitaPayment | null;
  defaults?: { from?: string; to?: string; amount?: number };
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const fx = useFxRates();
  const [from, setFrom] = useState(payment?.from ?? defaults?.from ?? "");
  const [to, setTo] = useState(payment?.to ?? defaults?.to ?? "");
  const [currency, setCurrency] = useState<Currency>(payment?.currency ?? v.currency);
  const initialAmount = payment?.amount ?? defaults?.amount;
  const [amountInput, setAmountInput] = useState(initialAmount ? num(initialAmount) : "");
  const [rateInput, setRateInput] = useState(payment && payment.currency !== v.currency ? num(payment.rate) : "");
  const [date, setDate] = useState(payment?.date ?? todayLocal());
  const [note, setNote] = useState(payment?.note ?? "");
  const myLeg0 = user ? payment?.legs?.[user.uid] : undefined;
  const [accountId, setAccountId] = useState<string>(payment ? (myLeg0?.accountId ?? "") : "");
  const [busy, setBusy] = useState(false);

  const fromM = v.members.find((m) => m.id === from);
  const toM = v.members.find((m) => m.id === to);
  const myRole = fromM?.uid === user?.uid ? "out" : toM?.uid === user?.uid ? "in" : null;
  const amount = parseAmount(amountInput) || 0;
  const suggestedRate = crossRate(currency, v.currency, fx?.rates);
  const rate = currency === v.currency ? 1 : parseAmount(rateInput) || suggestedRate || 0;

  const usable = useMemo(
    () => sortAccounts(accounts.filter((a) => a.active !== false && a.type !== "credit")),
    [accounts],
  );
  const options = usable.filter((a) => a.type !== "reserve" || accountCurrencies(a).includes(currency));
  const fallback =
    options.find((a) => a.isMain && accountCurrencies(a).includes(currency)) ??
    options.find((a) => accountCurrencies(a).includes(currency)) ??
    options[0];
  const effAccountId = accountId === "" ? (payment && !myLeg0 ? NO_ACCOUNT : (fallback?.id ?? NO_ACCOUNT)) : accountId;
  const currencyOptions = [...new Set<Currency>([v.currency, "ARS", "USD", currency])];
  const label = (id: string) => {
    const m = v.members.find((x) => x.id === id);
    return m?.uid === user?.uid ? "Yo" : firstName(m?.name ?? "");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!from || !to) return toast.error("Elegí quién pagó y a quién");
    if (from === to) return toast.error("Tienen que ser dos personas distintas");
    if (!(amount > 0)) return toast.error("Ingresá un monto");
    if (currency !== v.currency && !(rate > 0)) return toast.error("Poné la cotización");
    setBusy(true);
    try {
      await apiPost("/api/vaquitas/payments", {
        vaquitaId: v.id,
        paymentId: payment?.id,
        from,
        to,
        amount,
        currency,
        rate: currency === v.currency ? null : rate,
        date,
        note: note.trim(),
        ...(myRole ? { myAccountId: effAccountId === NO_ACCOUNT ? null : effAccountId } : {}),
      });
      toast.success(payment ? "Pago actualizado" : `Anotado: ${label(from)} → ${label(to)} ${formatMoney(amount, currency)}`);
      onDone?.();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!payment) return;
    if (!confirm("¿Borrar este pago? Se saca también de las cuentas de quienes lo registraron.")) return;
    setBusy(true);
    try {
      await apiPost("/api/vaquitas/payments/delete", { vaquitaId: v.id, paymentId: payment.id });
      toast.success("Pago borrado");
      onDone?.();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2">
        <Label>¿Quién pagó?</Label>
        <div className="flex flex-wrap gap-1.5">
          {v.members.map((m) => (
            <Chip key={m.id} active={from === m.id} onClick={() => setFrom(m.id)}>
              {label(m.id)}
            </Chip>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <Label>¿A quién?</Label>
        <div className="flex flex-wrap gap-1.5">
          {v.members
            .filter((m) => m.id !== from)
            .map((m) => (
              <Chip key={m.id} active={to === m.id} onClick={() => setTo(m.id)}>
                {label(m.id)}
              </Chip>
            ))}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="vqp-amount">Monto</Label>
          <Input
            id="vqp-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-12 text-lg"
            placeholder="0"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            onBlur={(e) => setAmountInput(formatAmountInput(e.target.value))}
          />
        </div>
        <CurrencyPicker value={currency} onChange={setCurrency} options={currencyOptions} />
      </div>

      {currency !== v.currency && (
        <div className="space-y-1 rounded-xl bg-muted/50 p-3">
          <Label htmlFor="vqp-rate" className="text-xs">
            Cotización: 1 {currencySymbol(currency)} = ? {currencySymbol(v.currency)}
          </Label>
          <Input
            id="vqp-rate"
            inputMode="decimal"
            className="h-10"
            placeholder={suggestedRate ? num(suggestedRate) : "Cotización"}
            value={rateInput}
            onChange={(e) => setRateInput(e.target.value)}
          />
          {amount > 0 && rate > 0 && (
            <p className="text-xs text-muted-foreground">Son {formatMoney(round2(amount * rate), v.currency)} en la vaquita.</p>
          )}
        </div>
      )}

      {myRole && (
        <div className="space-y-1">
          <Label>{myRole === "out" ? "¿De qué cuenta salió?" : "¿En qué cuenta entró?"}</Label>
          <Select value={effAccountId} onValueChange={(x) => setAccountId(x ?? NO_ACCOUNT)}>
            <SelectTrigger className="h-12 w-full">
              <SelectValue
                placeholder="Elegí la cuenta"
                items={[
                  ...options.map((a) => ({ value: a.id, label: a.name })),
                  { value: NO_ACCOUNT, label: "No lo anoto en mis cuentas" },
                ]}
              />
            </SelectTrigger>
            <SelectContent>
              {options.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
              <SelectItem value={NO_ACCOUNT}>No lo anoto en mis cuentas</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">No es gasto ni ingreso: mueve el saldo de tu cuenta.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="vqp-date">Fecha</Label>
          <Input id="vqp-date" type="date" className="h-11" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="vqp-note">Detalle</Label>
          <Input id="vqp-note" className="h-11" placeholder="Opcional" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>

      <div className="flex gap-2">
        {payment && (
          <Button type="button" variant="outline" className="h-12 text-destructive" onClick={remove} disabled={busy} aria-label="Borrar pago">
            <Trash2 className="size-4" />
          </Button>
        )}
        <Button type="submit" className="h-12 flex-1 bg-brand-grad text-white hover:opacity-95" disabled={busy}>
          {busy ? "Guardando…" : payment ? "Guardar cambios" : "Registrar pago"}
        </Button>
      </div>
    </form>
  );
}
