"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts } from "@/hooks/use-data";
import { useFxRates } from "@/hooks/use-fx-rates";
import { apiPost, errorText } from "@/lib/api";
import { sortAccounts } from "@/lib/domain/accounts";
import { CARD_CURRENCIES, accountCurrencies, type Currency } from "@/lib/domain/types";
import {
  carriedShares,
  computeShares,
  crossRate,
  defaultExpenseDate,
  firstName,
  vaquitaUnits,
  type Vaquita,
  type VaquitaExpense,
  type VaquitaSplitMode,
} from "@/lib/domain/vaquitas";
import { currencySymbol, formatAmountInput, formatMoney, parseAmount } from "@/lib/format";
import { Chip, CurrencyPicker, Segmented, num, todayLocal } from "./shared";

const NO_ACCOUNT = "__none__";
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cargar o editar un gasto de la vaquita. */
export function VaquitaExpenseForm({
  vaquita: v,
  expense,
  onDone,
}: {
  vaquita: Vaquita;
  expense?: VaquitaExpense | null;
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const fx = useFxRates();
  const me = v.members.find((m) => m.uid === user?.uid) ?? null;
  const units = useMemo(() => vaquitaUnits(v), [v]);
  const hasFamilies = units.some((u) => u.isFamily);

  const [description, setDescription] = useState(expense?.description ?? "");
  const [amountInput, setAmountInput] = useState(expense ? num(expense.amount) : "");
  const [currency, setCurrency] = useState<Currency>(expense?.currency ?? v.currency);
  const [rateInput, setRateInput] = useState(expense && expense.currency !== v.currency ? num(expense.rate) : "");
  const [date, setDate] = useState(expense?.date ?? defaultExpenseDate(v, todayLocal()));
  const payers0 = Object.keys(expense?.paidBy ?? {});
  const [multiPay, setMultiPay] = useState(payers0.length > 1);
  const [payer, setPayer] = useState<string>(payers0[0] ?? me?.id ?? v.members[0]?.id ?? "");
  const [payAmounts, setPayAmounts] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(expense?.paidBy ?? {}).map(([k, a]) => [k, num(a)])),
  );
  const [mode, setMode] = useState<VaquitaSplitMode>(expense?.splitMode ?? (hasFamilies ? "families" : "people"));
  const [among, setAmong] = useState<string[]>(
    expense?.splitMode && expense.splitMode !== "amounts" ? expense.splitAmong : v.members.map((m) => m.id),
  );
  const [amongUnits, setAmongUnits] = useState<string[]>(
    expense?.splitMode === "families" ? expense.splitAmong : units.map((u) => u.id),
  );
  const [shareAmounts, setShareAmounts] = useState<Record<string, string>>(
    expense?.splitMode === "amounts" ? Object.fromEntries(Object.entries(expense.shares).map(([k, a]) => [k, num(a)])) : {},
  );
  const [shareInFamily, setShareInFamily] = useState(expense?.shareInFamily ?? false);
  const myLeg0 = user ? expense?.legs?.[user.uid] : undefined;
  const [accountId, setAccountId] = useState<string>(expense ? (myLeg0?.accountId ?? NO_ACCOUNT) : "");
  const [installments, setInstallments] = useState(String(myLeg0?.installments ?? 1));
  const [busy, setBusy] = useState(false);

  const amount = parseAmount(amountInput) || 0;
  const suggestedRate = crossRate(currency, v.currency, fx?.rates);
  const rate = currency === v.currency ? 1 : parseAmount(rateInput) || suggestedRate || 0;

  const paidBy: Record<string, number> = multiPay
    ? Object.fromEntries(Object.entries(payAmounts).map(([k, s]) => [k, parseAmount(s) || 0]).filter(([, a]) => (a as number) > 0))
    : payer
      ? { [payer]: amount }
      : {};
  const paidSum = round2(Object.values(paidBy).reduce((s, a) => s + a, 0));
  const iPaid = !!me && (paidBy[me.id] ?? 0) > 0;

  const amounts = Object.fromEntries(Object.entries(shareAmounts).map(([k, s]) => [k, parseAmount(s) || 0]));
  const shareSum = round2(Object.values(amounts).reduce((s, a) => s + a, 0));
  const shares = computeShares(v, {
    amount,
    splitMode: mode,
    splitAmong: mode === "families" ? amongUnits : among,
    amounts,
  });

  // ¿Pagó alguien de una familia donde hay otros con la app?
  const familyMates = (() => {
    const names = new Set<string>();
    for (const pid of Object.keys(paidBy)) {
      const p = v.members.find((m) => m.id === pid);
      if (!p?.familyId || !p.uid) continue;
      for (const m of v.members) if (m.familyId === p.familyId && m.uid && m.id !== p.id) names.add(firstName(m.name));
    }
    return [...names];
  })();

  const myPart =
    user && !shares.error
      ? (carriedShares(v, { paidBy, shares: shares.shares, shareInFamily }).get(user.uid) ?? 0)
      : null;

  const usable = useMemo(() => sortAccounts(accounts.filter((a) => a.active !== false)), [accounts]);
  const accOptions = usable.filter((a) =>
    a.type === "credit" ? CARD_CURRENCIES.includes(currency) : a.type !== "reserve" || accountCurrencies(a).includes(currency),
  );
  const defaultAccount =
    accOptions.find((a) => a.isMain && accountCurrencies(a).includes(currency)) ??
    accOptions.find((a) => a.type !== "credit" && accountCurrencies(a).includes(currency)) ??
    accOptions[0];
  const effAccountId = accountId === "" ? (defaultAccount?.id ?? NO_ACCOUNT) : accountId;
  const effAccount = accOptions.find((a) => a.id === effAccountId);

  const currencyOptions = [...new Set<Currency>([v.currency, "ARS", "USD", currency])];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return toast.error("Poné qué fue");
    if (!(amount > 0)) return toast.error("Ingresá un monto");
    if (Object.keys(paidBy).length === 0) return toast.error("Elegí quién pagó");
    if (multiPay && Math.abs(paidSum - amount) >= 0.01) return toast.error(`Lo que pagaron suma ${num(paidSum)} y el gasto es ${num(amount)}`);
    if (shares.error) return toast.error(shares.error);
    if (currency !== v.currency && !(rate > 0)) return toast.error("Poné la cotización");
    setBusy(true);
    try {
      await apiPost("/api/vaquitas/expenses", {
        vaquitaId: v.id,
        expenseId: expense?.id,
        description: description.trim(),
        date,
        amount,
        currency,
        rate: currency === v.currency ? null : rate,
        paidBy,
        splitMode: mode,
        splitAmong: mode === "families" ? amongUnits : among,
        amounts: mode === "amounts" ? amounts : undefined,
        shareInFamily,
        myLeg: iPaid && effAccount ? { accountId: effAccount.id, installments: Number(installments) || 1 } : null,
      });
      toast.success(expense ? "Gasto actualizado" : "Gasto cargado");
      onDone?.();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!expense) return;
    if (!confirm(`¿Borrar «${expense.description}»? Se saca también de las cuentas de todos.`)) return;
    setBusy(true);
    try {
      await apiPost("/api/vaquitas/expenses/delete", { vaquitaId: v.id, expenseId: expense.id });
      toast.success("Gasto borrado");
      onDone?.();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleAmong = (id: string) => setAmong((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleUnit = (id: string) => setAmongUnits((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="vqe-desc">¿Qué fue?</Label>
        <Input
          id="vqe-desc"
          className="h-12"
          placeholder="Cena, nafta, súper…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="vqe-amount">Monto</Label>
          <Input
            id="vqe-amount"
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
          <Label htmlFor="vqe-rate" className="text-xs">
            Cotización: 1 {currencySymbol(currency)} = ? {currencySymbol(v.currency)}
          </Label>
          <Input
            id="vqe-rate"
            inputMode="decimal"
            className="h-10"
            placeholder={suggestedRate ? num(suggestedRate) : "Cotización"}
            value={rateInput}
            onChange={(e) => setRateInput(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {suggestedRate && !rateInput ? "Oficial del día (BCRA). " : ""}
            {amount > 0 && rate > 0 && `Son ${formatMoney(round2(amount * rate), v.currency)} en la vaquita.`}
          </p>
        </div>
      )}

      <div className="space-y-1">
        <Label htmlFor="vqe-date">Fecha</Label>
        <Input id="vqe-date" type="date" className="h-11" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>¿Quién pagó?</Label>
          <button type="button" className="text-xs font-medium text-brand" onClick={() => setMultiPay((x) => !x)}>
            {multiPay ? "Pagó uno solo" : "Pagaron varios"}
          </button>
        </div>
        {!multiPay ? (
          <div className="flex flex-wrap gap-1.5">
            {v.members.map((m) => (
              <Chip key={m.id} active={payer === m.id} onClick={() => setPayer(m.id)}>
                {m.uid === user?.uid ? "Yo" : firstName(m.name)}
              </Chip>
            ))}
          </div>
        ) : (
          <div className="divide-y rounded-xl border">
            {v.members.map((m) => (
              <div key={m.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="flex-1 text-sm">{m.uid === user?.uid ? "Yo" : m.name}</span>
                <Input
                  inputMode="decimal"
                  className="h-9 w-32 text-right"
                  placeholder="0"
                  value={payAmounts[m.id] ?? ""}
                  onChange={(e) => setPayAmounts((p) => ({ ...p, [m.id]: e.target.value }))}
                  onBlur={(e) => setPayAmounts((p) => ({ ...p, [m.id]: formatAmountInput(e.target.value) }))}
                />
              </div>
            ))}
            <div className={`flex justify-between px-3 py-2 text-xs ${Math.abs(paidSum - amount) >= 0.01 ? "text-destructive" : "text-muted-foreground"}`}>
              <span>Suman</span>
              <span className="tabular-nums">
                {formatMoney(paidSum, currency)} de {formatMoney(amount, currency)}
              </span>
            </div>
          </div>
        )}
      </div>

      {iPaid && (
        <div className="space-y-1">
          <Label>¿Con qué pagaste?</Label>
          <Select value={effAccountId} onValueChange={(x) => setAccountId(x ?? NO_ACCOUNT)}>
            <SelectTrigger className="h-12 w-full">
              <SelectValue
                placeholder="Elegí la cuenta"
                items={[
                  ...accOptions.map((a) => ({ value: a.id, label: a.name })),
                  { value: NO_ACCOUNT, label: "No lo anoto en mis cuentas" },
                ]}
              />
            </SelectTrigger>
            <SelectContent>
              {accOptions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
              <SelectItem value={NO_ACCOUNT}>No lo anoto en mis cuentas</SelectItem>
            </SelectContent>
          </Select>
          {effAccount?.type === "credit" && (
            <div className="flex items-center gap-2 pt-1">
              <Label htmlFor="vqe-cuotas" className="text-xs text-muted-foreground">
                Cuotas
              </Label>
              <Input
                id="vqe-cuotas"
                inputMode="numeric"
                className="h-9 w-20"
                value={installments}
                onChange={(e) => setInstallments(e.target.value.replace(/\D/g, ""))}
              />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Sale entero de esa cuenta, pero en tus gastos cuenta solo lo que te toca.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>¿Entre quiénes se divide?</Label>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "people", label: "Por persona" },
            ...(hasFamilies ? [{ value: "families" as const, label: "Por familia" }] : []),
            { value: "amounts", label: "Montos" },
          ]}
        />
        {mode === "people" && (
          <div className="flex flex-wrap gap-1.5">
            {v.members.map((m) => (
              <Chip key={m.id} active={among.includes(m.id)} onClick={() => toggleAmong(m.id)}>
                {m.uid === user?.uid ? "Yo" : firstName(m.name)}
              </Chip>
            ))}
          </div>
        )}
        {mode === "families" && (
          <div className="flex flex-wrap gap-1.5">
            {units.map((u) => (
              <Chip key={u.id} active={amongUnits.includes(u.id)} onClick={() => toggleUnit(u.id)}>
                {u.isFamily ? u.name : u.memberIds.includes(me?.id ?? "") ? "Yo" : firstName(u.name)}
              </Chip>
            ))}
          </div>
        )}
        {mode === "amounts" && (
          <div className="divide-y rounded-xl border">
            {v.members.map((m) => (
              <div key={m.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="flex-1 text-sm">{m.uid === user?.uid ? "Yo" : m.name}</span>
                <Input
                  inputMode="decimal"
                  className="h-9 w-32 text-right"
                  placeholder="0"
                  value={shareAmounts[m.id] ?? ""}
                  onChange={(e) => setShareAmounts((p) => ({ ...p, [m.id]: e.target.value }))}
                  onBlur={(e) => setShareAmounts((p) => ({ ...p, [m.id]: formatAmountInput(e.target.value) }))}
                />
              </div>
            ))}
            <div className={`flex justify-between px-3 py-2 text-xs ${Math.abs(shareSum - amount) >= 0.01 ? "text-destructive" : "text-muted-foreground"}`}>
              <span>Suman</span>
              <span className="tabular-nums">
                {formatMoney(shareSum, currency)} de {formatMoney(amount, currency)}
              </span>
            </div>
          </div>
        )}
        {amount > 0 && !shares.error && mode !== "amounts" && (
          <p className="text-xs text-muted-foreground">
            {mode === "families"
              ? `${formatMoney(round2(amount / Math.max(1, amongUnits.length)), currency)} cada parte`
              : `${formatMoney(round2(amount / Math.max(1, among.length)), currency)} cada uno`}
          </p>
        )}
      </div>

      {familyMates.length > 0 && (
        <label className="flex items-center justify-between gap-3 rounded-2xl border p-3">
          <span>
            <span className="block text-sm font-medium">Compartir con {familyMates.join(" y ")}</span>
            <span className="block text-xs text-muted-foreground">
              Que lo vea en sus gastos (cada uno su parte). Si no, la parte de la familia queda en los gastos de quien pagó.
            </span>
          </span>
          <Switch checked={shareInFamily} onCheckedChange={setShareInFamily} />
        </label>
      )}

      {myPart != null && amount > 0 && (
        <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Va a tus gastos</span>
          <span className="font-semibold tabular-nums">{formatMoney(myPart, currency)}</span>
        </div>
      )}

      <div className="flex gap-2">
        {expense && (
          <Button type="button" variant="outline" className="h-12 text-destructive" onClick={remove} disabled={busy} aria-label="Borrar gasto">
            <Trash2 className="size-4" />
          </Button>
        )}
        <Button type="submit" className="h-12 flex-1 bg-brand-grad text-white hover:opacity-95" disabled={busy}>
          {busy ? "Guardando…" : expense ? "Guardar cambios" : "Cargar gasto"}
        </Button>
      </div>
    </form>
  );
}
