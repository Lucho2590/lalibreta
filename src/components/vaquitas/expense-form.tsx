"use client";

import { useMemo, useState } from "react";
import { CreditCard, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { Chip, CurrencyPicker, Segmented, ddmm, num, todayLocal } from "./shared";

const NO_ACCOUNT = "__none__";
const round2 = (n: number) => Math.round(n * 100) / 100;
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** Un gasto mío ya cargado que paso a la vaquita (no se duplica: lo reemplaza). */
export interface MovedTransaction {
  id: string;
  description: string;
  amount: number;
  currency: Currency;
  /** YYYY-MM-DD (fecha local de la compra). */
  date: string;
  accountName: string;
  installments: number;
}

/** "Hoy", "Ayer" o "sáb 22/11". */
const dateLabel = (ymd: string) => {
  const today = todayLocal();
  if (ymd === today) return "Hoy";
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (ymd === yesterday) return "Ayer";
  return `${WEEKDAYS[new Date(`${ymd}T12:00:00`).getDay()]} ${ddmm(ymd)}`;
};

/** Cargar o editar un gasto de la vaquita (o pasarle uno ya cargado). */
export function VaquitaExpenseForm({
  vaquita: v,
  expense,
  fromTransaction,
  onDone,
}: {
  vaquita: Vaquita;
  expense?: VaquitaExpense | null;
  fromTransaction?: MovedTransaction | null;
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const fx = useFxRates();
  const me = v.members.find((m) => m.uid === user?.uid) ?? null;
  const units = useMemo(() => vaquitaUnits(v), [v]);
  const hasFamilies = units.some((u) => u.isFamily);
  // Yo primero, después el resto.
  const people = useMemo(() => [...v.members].sort((a, b) => Number(b.uid === user?.uid) - Number(a.uid === user?.uid)), [v.members, user?.uid]);
  const moved = !expense && fromTransaction ? fromTransaction : null;

  const [description, setDescription] = useState(expense?.description ?? moved?.description ?? "");
  const [amountInput, setAmountInput] = useState(expense ? num(expense.amount) : moved ? num(moved.amount) : "");
  const [currency, setCurrency] = useState<Currency>(expense?.currency ?? moved?.currency ?? v.currency);
  const [rateInput, setRateInput] = useState(expense && expense.currency !== v.currency ? num(expense.rate) : "");
  const [date, setDate] = useState(expense?.date ?? moved?.date ?? defaultExpenseDate(v, todayLocal()));
  const payers0 = Object.keys(expense?.paidBy ?? {});
  const [multiPay, setMultiPay] = useState(payers0.length > 1);
  const [payer, setPayer] = useState<string>(payers0[0] ?? me?.id ?? v.members[0]?.id ?? "");
  const [payAmounts, setPayAmounts] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(expense?.paidBy ?? {}).map(([k, a]) => [k, num(a)])),
  );
  const defaultMode: VaquitaSplitMode = hasFamilies ? "families" : "people";
  const [mode, setMode] = useState<VaquitaSplitMode>(expense?.splitMode ?? defaultMode);
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
  const [editDate, setEditDate] = useState(false);
  const [editSplit, setEditSplit] = useState(false);
  const [busy, setBusy] = useState(false);

  const amount = parseAmount(amountInput) || 0;
  const suggestedRate = crossRate(currency, v.currency, fx?.rates);
  const rate = currency === v.currency ? 1 : parseAmount(rateInput) || suggestedRate || 0;

  const paidBy: Record<string, number> = moved && me
    ? { [me.id]: amount }
    : multiPay
      ? Object.fromEntries(Object.entries(payAmounts).map(([k, s]) => [k, parseAmount(s) || 0]).filter(([, a]) => (a as number) > 0))
      : payer
        ? { [payer]: amount }
        : {};
  const paidSum = round2(Object.values(paidBy).reduce((s, a) => s + a, 0));
  const iPaid = !!me && (paidBy[me.id] ?? 0) > 0;
  const payerIds = Object.keys(paidBy);

  const amounts = Object.fromEntries(Object.entries(shareAmounts).map(([k, s]) => [k, parseAmount(s) || 0]));
  const shareSum = round2(Object.values(amounts).reduce((s, a) => s + a, 0));
  const splitAmong = mode === "families" ? amongUnits : among;
  const shares = computeShares(v, { amount, splitMode: mode, splitAmong, amounts });

  // ¿Pagó alguien de una familia donde hay otros con la app?
  const familyMates = (() => {
    const names = new Set<string>();
    for (const pid of payerIds) {
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
  const nameOf = (id: string) => {
    const m = v.members.find((x) => x.id === id);
    return m?.uid === user?.uid ? "vos" : firstName(m?.name ?? "Alguien");
  };
  const listNames = (names: string[]) =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;

  // Resumen del reparto ("Entre todos · $ 10.000 cada uno").
  const splitSummary = (() => {
    if (mode === "amounts") return "Por montos";
    if (mode === "families") {
      const all = amongUnits.length === units.length;
      const who = all
        ? "Entre todas las partes"
        : `Entre ${listNames(amongUnits.map((id) => {
            const u = units.find((x) => x.id === id);
            return u ? (u.isFamily ? u.name : u.memberIds.includes(me?.id ?? "") ? "vos" : firstName(u.name)) : "";
          }))}`;
      return amount > 0 && amongUnits.length
        ? `${who} · ${formatMoney(round2(amount / amongUnits.length), currency)} cada parte`
        : who;
    }
    const all = among.length === v.members.length;
    const who = all ? "Entre todos" : `Entre ${listNames(among.map(nameOf))}`;
    return amount > 0 && among.length ? `${who} · ${formatMoney(round2(amount / among.length), currency)} cada uno` : who;
  })();
  const splitOpen = editSplit || (!!shares.error && amount > 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(amount > 0)) return toast.error("Ingresá un monto");
    if (payerIds.length === 0) return toast.error("Elegí quién pagó");
    if (multiPay && !moved && Math.abs(paidSum - amount) >= 0.01) {
      return toast.error(`Lo que pagaron suma ${num(paidSum)} y el gasto es ${num(amount)}`);
    }
    if (shares.error) {
      setEditSplit(true);
      return toast.error(shares.error);
    }
    if (currency !== v.currency && !(rate > 0)) return toast.error("Poné la cotización");
    setBusy(true);
    try {
      await apiPost("/api/vaquitas/expenses", {
        vaquitaId: v.id,
        expenseId: expense?.id,
        description: description.trim() || "Gasto",
        date,
        amount,
        currency,
        rate: currency === v.currency ? null : rate,
        paidBy,
        splitMode: mode,
        splitAmong,
        amounts: mode === "amounts" ? amounts : undefined,
        shareInFamily,
        ...(moved
          ? { fromTransactionId: moved.id }
          : { myLeg: iPaid && effAccount ? { accountId: effAccount.id, installments: Number(installments) || 1 } : null }),
      });
      toast.success(moved ? `Listo: pasó a «${v.name}»` : expense ? "Gasto actualizado" : "Gasto cargado");
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

  // Si pagó otro: qué pasa con mi parte.
  const othersPaid = !iPaid && payerIds.length > 0 && amount > 0;
  const payersText = listNames(payerIds.map(nameOf));

  return (
    <form onSubmit={submit} className="space-y-5">
      {/* 1. ¿Quién pagó? */}
      {moved ? (
        <div className="flex items-center gap-3 rounded-2xl border bg-muted/40 p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
            <CreditCard className="size-5" />
          </span>
          <div className="min-w-0 text-sm">
            <div className="font-medium">Pagaste vos con {moved.accountName}</div>
            <div className="text-xs text-muted-foreground">
              {moved.installments > 1 ? `${moved.installments} cuotas · ` : ""}Sigue en esa cuenta igual que antes; en tus gastos queda solo tu parte.
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>¿Quién pagó?</Label>
            <button type="button" className="text-xs font-medium text-brand" onClick={() => setMultiPay((x) => !x)}>
              {multiPay ? "Pagó uno solo" : "Pagaron varios"}
            </button>
          </div>
          {!multiPay ? (
            <div className="grid grid-cols-4 gap-2">
              {people.map((m) => {
                const active = payer === m.id;
                const label = m.uid === user?.uid ? "Yo" : firstName(m.name);
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPayer(m.id)}
                    className={cn(
                      "flex min-w-0 flex-col items-center gap-1 rounded-2xl border p-2 transition",
                      active ? "border-brand bg-brand/10" : "border-border hover:bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-10 items-center justify-center rounded-full text-base font-semibold",
                        active ? "bg-brand text-white" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {label.charAt(0).toUpperCase()}
                    </span>
                    <span className={cn("w-full truncate text-center text-xs font-medium", active ? "text-brand" : "text-muted-foreground")}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="divide-y rounded-xl border">
              {people.map((m) => (
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
      )}

      {/* 2. Monto */}
      <div className="space-y-1">
        <Label htmlFor="vqe-amount">Monto</Label>
        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <Input
            id="vqe-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-14 text-2xl font-semibold tabular-nums"
            placeholder="0"
            value={amountInput}
            readOnly={!!moved}
            onChange={(e) => setAmountInput(e.target.value)}
            onBlur={(e) => setAmountInput(formatAmountInput(e.target.value))}
          />
          {moved ? (
            <span className="px-3 text-sm font-medium text-muted-foreground">{currencySymbol(currency)}</span>
          ) : (
            <CurrencyPicker value={currency} onChange={setCurrency} options={currencyOptions} />
          )}
        </div>
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

      {/* 3. ¿Qué fue? */}
      <div className="space-y-1">
        <Label htmlFor="vqe-desc">
          ¿Qué fue? <span className="font-normal text-muted-foreground">(opcional)</span>
        </Label>
        <Input
          id="vqe-desc"
          className="h-11"
          placeholder="Cena, nafta, súper…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* 4. Con qué pagué yo, o qué pasa si pagó otro */}
      {iPaid && !moved && (
        <div className="space-y-1">
          <Label>¿Con qué pagaste?</Label>
          <div className={cn("grid gap-2", effAccount?.type === "credit" ? "grid-cols-[1fr_6rem]" : "grid-cols-1")}>
            <Select value={effAccountId} onValueChange={(x) => setAccountId(x ?? NO_ACCOUNT)}>
              <SelectTrigger className="h-11 w-full">
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
              <div className="relative">
                <Input
                  id="vqe-cuotas"
                  aria-label="Cuotas"
                  inputMode="numeric"
                  className="h-11 pr-14 text-right"
                  value={installments}
                  onChange={(e) => setInstallments(e.target.value.replace(/\D/g, ""))}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  {Number(installments) === 1 ? "cuota" : "cuotas"}
                </span>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Sale entero de esa cuenta; en tus gastos queda solo tu parte.</p>
        </div>
      )}
      {othersPaid && (
        <p className="rounded-xl bg-muted/50 px-3 py-2 text-sm">
          {multiPay ? "Lo pusieron" : "Lo puso"} <span className="font-medium">{payersText}</span>.{" "}
          {myPart == null ? null : myPart >= 0.01 ? (
            <>
              Tu parte, <span className="font-medium tabular-nums">{formatMoney(myPart, currency)}</span>, va a tus gastos y
              queda para saldar en la vaquita.
            </>
          ) : me && !shares.error && (shares.shares[me.id] ?? 0) >= 0.01 ? (
            `Tu parte queda en los gastos de ${payersText} (en la familia no hay deudas).`
          ) : (
            "A vos no te toca nada de este gasto."
          )}
        </p>
      )}

      {/* 5. Fecha y reparto: resumidos, se abren si hace falta */}
      <div className="divide-y rounded-2xl border">
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">Fecha</span>
            <span className="flex-1 text-sm font-medium">{dateLabel(date)}</span>
            <button type="button" className="text-xs font-medium text-brand" onClick={() => setEditDate((x) => !x)}>
              {editDate ? "Listo" : "Cambiar"}
            </button>
          </div>
          {editDate && (
            <Input id="vqe-date" type="date" className="mt-2 h-11" value={date} onChange={(e) => setDate(e.target.value)} />
          )}
        </div>
        <div className="space-y-2 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">Reparto</span>
            <span className={cn("flex-1 text-sm font-medium", shares.error && amount > 0 && "text-destructive")}>
              {shares.error && amount > 0 && mode !== "amounts" ? shares.error : splitSummary}
            </span>
            <button type="button" className="text-xs font-medium text-brand" onClick={() => setEditSplit((x) => !x)}>
              {splitOpen ? "Listo" : "Cambiar"}
            </button>
          </div>
          {splitOpen && (
            <div className="space-y-2">
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
                  {people.map((m) => (
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
                  {people.map((m) => (
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
            </div>
          )}
        </div>
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

      {/* 6. Pie: lo que va a mis gastos y el botón */}
      <div className="sticky bottom-0 -mx-5 space-y-2 border-t bg-background px-5 pb-1 pt-3">
        {myPart != null && amount > 0 && (
          <div className="flex items-center justify-between text-sm">
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
            {busy ? "Guardando…" : moved ? "Pasar a la vaquita" : expense ? "Guardar cambios" : "Cargar gasto"}
          </Button>
        </div>
      </div>
    </form>
  );
}
