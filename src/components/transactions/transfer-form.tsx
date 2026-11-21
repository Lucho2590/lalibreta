"use client";

import { useMemo, useState } from "react";
import { ArrowDown } from "lucide-react";
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
import { useAccounts, useAllInstallments } from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { useFxRates } from "@/hooks/use-fx-rates";
import { createTransactionWithInstallments } from "@/lib/domain/installments";
import { sortAccounts, updateAccount } from "@/lib/domain/accounts";
import { computeAccountBalances } from "@/lib/domain/balances";
import { cardStatementToPay } from "@/lib/domain/card-summary";
import type { Account, Currency } from "@/lib/domain/types";
import { CARD_CURRENCIES, CURRENCIES, accountCurrencies, paymentMonthOf } from "@/lib/domain/types";
import {
  currencyLabel,
  currencySymbol,
  formatAmountInput,
  formatMoney,
  formatShortDate,
  parseAmount,
} from "@/lib/format";

const r2 = (n: number) => Math.round(n * 100) / 100;
const numberText = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Transferencia entre cuentas propias o pago de tarjeta, en pesos Y/O dólares
 * en un solo paso (ej. pagar la Visa: $ 74.915 + US$ 0,07). Cada moneda se
 * guarda como su propio movimiento. En un pago de tarjeta, la parte en
 * dólares se puede pagar con pesos a una cotización.
 */
export function TransferForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: allInstallments } = useAllInstallments();
  const fx = useFxRates();
  const usdRate = fx?.rates.USD ?? null;

  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [arsInput, setArsInput] = useState("");
  const [usdInput, setUsdInput] = useState("");
  // Otras monedas de la cuenta de origen (euros, libras…), solo entre cuentas propias.
  const [otherInputs, setOtherInputs] = useState<Partial<Record<Currency, string>>>({});
  const [usdPayWith, setUsdPayWith] = useState<Currency | null>(null);
  const [rateInput, setRateInput] = useState("");
  const [date, setDate] = useState(todayLocal);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const active = useMemo(() => sortAccounts(accounts.filter((a) => a.active !== false)), [accounts]);
  const fromOptions = active.filter((a) => a.type !== "credit" && a.id !== toId);
  const toOptions = active.filter((a) => a.id !== fromId);
  const from = active.find((a) => a.id === fromId);
  const to = active.find((a) => a.id === toId);
  const isCard = to?.type === "credit";
  const has = (a: Account | undefined, c: Currency) => !a || accountCurrencies(a).includes(c);

  // Qué monedas se pueden mandar: las de la cuenta de origen. A una tarjeta, la
  // parte en dólares se puede pagar con pesos aunque la cuenta no tenga dólares.
  const showARS = has(from, "ARS");
  const showUSD = has(from, "USD") || isCard;
  const usdWith: Currency =
    !isCard ? "USD" : usdPayWith === "ARS" || !has(from, "USD") ? "ARS" : "USD";

  const ars = showARS ? parseAmount(arsInput) || 0 : 0;
  const usd = showUSD ? parseAmount(usdInput) || 0 : 0;
  const rate = parseAmount(rateInput) || usdRate || 0;
  const extraCurrencies: Currency[] =
    !isCard && from ? accountCurrencies(from).filter((c) => !CARD_CURRENCIES.includes(c)) : [];
  const extra = Object.fromEntries(
    extraCurrencies.map((c) => [c, parseAmount(otherInputs[c] ?? "") || 0]),
  ) as Partial<Record<Currency, number>>;
  const amountOf = (c: Currency) => (c === "ARS" ? ars : c === "USD" ? usd : (extra[c] ?? 0));
  const usdInPesos = usdWith === "ARS" && usd > 0 && rate > 0 ? r2(usd * rate) : 0;

  const balances = useMemo(() => computeAccountBalances(active, allInstallments), [active, allInstallments]);
  const fromBalance = from ? balances.get(from.id)?.amounts : undefined;

  // Pago de tarjeta: el resumen que toca pagar y cuánto falta.
  const currentMonth = paymentMonthOf(new Date());
  const toPay = useMemo(
    () => (isCard && to ? cardStatementToPay(allInstallments, to, currentMonth) : null),
    [isCard, to, allInstallments, currentMonth],
  );
  const fill = (c: Currency | "all") => {
    if (!toPay) return;
    const p = toPay.summary.pending;
    if (c !== "USD") setArsInput(p.ARS > 0.009 ? numberText(p.ARS) : "");
    if (c !== "ARS") setUsdInput(p.USD > 0.009 ? numberText(p.USD) : "");
  };

  // Destino sin una de las monedas (ej. pasar dólares a Mercado Pago que solo tenía
  // pesos): se le agrega al guardar. Las cobachas son de una sola moneda: ahí no.
  const missingAtDest = CURRENCIES.filter((c) => !isCard && to && amountOf(c) > 0 && !has(to, c));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!from) return toast.error("Elegí de qué cuenta sale");
    if (!to) return toast.error("Elegí a qué cuenta va");
    if (!CURRENCIES.some((c) => amountOf(c) > 0)) return toast.error("Ingresá un monto");
    if (usd > 0 && usdWith === "ARS" && !(rate > 0)) return toast.error("Falta la cotización");
    if (to.type === "reserve" && missingAtDest.length) {
      return toast.error(`${to.name} es una cobacha en ${currencyLabel(accountCurrencies(to)[0]).toLowerCase()}`);
    }
    setSubmitting(true);
    try {
      if (missingAtDest.length) {
        await updateAccount(user.uid, to.id, { currencies: [...accountCurrencies(to), ...missingAtDest] });
      }
      const purchaseDate = new Date(`${date}T12:00:00`);
      const base = {
        accountId: from.id,
        toAccountId: to.id,
        categoryId: "",
        description: description.trim() || (isCard ? `Pago ${to.name}` : `Transferencia a ${to.name}`),
        purchaseDate,
        kind: "transfer" as const,
        installments: 1,
        transferType: isCard ? ("card-payment" as const) : ("transfer" as const),
      };
      if (ars > 0) {
        await createTransactionWithInstallments(user.uid, from, { ...base, totalAmount: r2(ars), currency: "ARS" });
      }
      if (usd > 0) {
        await createTransactionWithInstallments(
          user.uid,
          from,
          usdWith === "ARS"
            ? { ...base, totalAmount: usdInPesos, currency: "ARS", toCurrency: "USD", toAmount: r2(usd), rate }
            : { ...base, totalAmount: r2(usd), currency: "USD" },
        );
      }
      for (const c of extraCurrencies) {
        const v = extra[c] ?? 0;
        if (v > 0) await createTransactionWithInstallments(user.uid, from, { ...base, totalAmount: r2(v), currency: c });
      }
      const parts = CURRENCIES.filter((c) => amountOf(c) > 0)
        .map((c) => formatMoney(amountOf(c), c))
        .join(" + ");
      toast.success(isCard ? `Pago de ${to.name}: ${parts}` : `Transferiste ${parts} a ${to.name}`);
      setArsInput("");
      setUsdInput("");
      setOtherInputs({});
      setDescription("");
      onSubmitted?.();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar");
    } finally {
      setSubmitting(false);
    }
  };

  const accountSelect = (
    label: string,
    value: string,
    options: Account[],
    onChange: (id: string) => void,
    placeholder: string,
  ) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger className="h-12 w-full">
          <SelectValue placeholder={placeholder} items={options.map((a) => ({ value: a.id, label: a.name }))} />
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
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
        {accountSelect("De cuenta", fromId, fromOptions, setFromId, "Cuenta origen")}
        {from && fromBalance && (
          <p className="-mt-2 text-xs text-muted-foreground">
            Tenés {accountCurrencies(from).map((c) => formatMoney(fromBalance[c], c)).join(" · ")}
          </p>
        )}
        <div className="flex justify-center">
          <ArrowDown className="size-4 text-muted-foreground" />
        </div>
        {accountSelect(
          "A cuenta",
          toId,
          toOptions,
          (id) => {
            setToId(id);
            setUsdPayWith(null);
            // Tarjeta sin origen elegido: por defecto, el banco de la tarjeta.
            const card = active.find((a) => a.id === id);
            if (card?.type === "credit" && card.parentId && !fromId) setFromId(card.parentId);
          },
          "Cuenta destino o tarjeta",
        )}

        {isCard && (
          <div className="rounded-lg bg-background p-3 text-sm">
            {toPay ? (
              <>
                <div className="text-xs text-muted-foreground">
                  {toPay.summary.dueDate
                    ? `Resumen que vence el ${formatShortDate(toPay.summary.dueDate)}`
                    : "Resumen a pagar"}
                  {toPay.summary.paid.ARS > 0 || toPay.summary.paid.USD > 0 ? " · falta pagar" : ""}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {CARD_CURRENCIES
                    .filter((c) => toPay.summary.pending[c] > 0.009)
                    .map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => fill(c)}
                        className="rounded-full border bg-muted/40 px-3 py-1.5 font-semibold tabular-nums transition hover:bg-muted"
                      >
                        {formatMoney(toPay.summary.pending[c], c)}
                      </button>
                    ))}
                  {toPay.summary.pending.ARS > 0.009 && toPay.summary.pending.USD > 0.009 && (
                    <button
                      type="button"
                      onClick={() => fill("all")}
                      className="rounded-full bg-brand px-3 py-1.5 font-semibold text-brand-foreground transition hover:opacity-90"
                    >
                      Pagar todo
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Tocá un monto para pagarlo.
                  {toPay.monthKey > currentMonth && " Este resumen todavía puede sumar consumos hasta el cierre."}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">✓ La tarjeta no tiene resúmenes pendientes.</p>
            )}
          </div>
        )}
      </div>

      <div className={`grid gap-3 ${showARS && showUSD ? "grid-cols-2" : "grid-cols-1"}`}>
        {showARS && (
          <div className="space-y-1">
            <Label htmlFor="tr-ars">Pesos</Label>
            <Input
              id="tr-ars"
              inputMode="decimal"
              autoComplete="off"
              placeholder="$ 0"
              className="h-12 text-lg"
              value={arsInput}
              onChange={(e) => setArsInput(e.target.value)}
              onBlur={(e) => setArsInput(formatAmountInput(e.target.value))}
            />
          </div>
        )}
        {showUSD && (
          <div className="space-y-1">
            <Label htmlFor="tr-usd">Dólares</Label>
            <Input
              id="tr-usd"
              inputMode="decimal"
              autoComplete="off"
              placeholder="US$ 0"
              className="h-12 text-lg"
              value={usdInput}
              onChange={(e) => setUsdInput(e.target.value)}
              onBlur={(e) => setUsdInput(formatAmountInput(e.target.value))}
            />
          </div>
        )}
      </div>
      {extraCurrencies.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {extraCurrencies.map((c) => (
            <div key={c} className="space-y-1">
              <Label htmlFor={`tr-${c}`}>{currencyLabel(c)}</Label>
              <Input
                id={`tr-${c}`}
                inputMode="decimal"
                autoComplete="off"
                placeholder={`${currencySymbol(c)} 0`}
                className="h-12 text-lg"
                value={otherInputs[c] ?? ""}
                onChange={(e) => setOtherInputs((prev) => ({ ...prev, [c]: e.target.value }))}
                onBlur={(e) => setOtherInputs((prev) => ({ ...prev, [c]: formatAmountInput(e.target.value) }))}
              />
            </div>
          ))}
        </div>
      )}
      {[showARS, showUSD].filter(Boolean).length + extraCurrencies.length > 1 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Completá uno o varios: se guarda todo junto.
        </p>
      )}

      {isCard && usd > 0 && (
        <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
          <Label>Los dólares los pagás con</Label>
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            {(["USD", "ARS"] as Currency[])
              .filter((c) => c === "ARS" || has(from, "USD"))
              .map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setUsdPayWith(c)}
                  className={`h-8 rounded-md px-3 text-xs font-medium transition ${
                    usdWith === c ? "bg-background shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  {c === "USD" ? "US$ Dólares" : "$ Pesos"}
                </button>
              ))}
          </div>
          {usdWith === "ARS" && (
            <div className="space-y-1">
              <Label htmlFor="tr-rate">Cotización</Label>
              <Input
                id="tr-rate"
                inputMode="decimal"
                className="h-11"
                placeholder={usdRate ? numberText(usdRate) : "Ej: 1.480"}
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                onBlur={(e) => setRateInput(formatAmountInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {usdInPesos > 0 && (
                  <>
                    {formatMoney(usd, "USD")} = <span className="font-semibold">{formatMoney(usdInPesos, "ARS")}</span>{" "}
                    que salen de {from?.name ?? "la cuenta"}.{" "}
                  </>
                )}
                {!rateInput && usdRate && "Oficial BCRA; si te cobraron otra, escribila."}
              </p>
            </div>
          )}
        </div>
      )}

      {missingAtDest.length > 0 && to && (
        <p className="text-xs text-muted-foreground">
          {to.type === "reserve"
            ? `${to.name} no maneja ${currencyLabel(missingAtDest[0]).toLowerCase()}.`
            : `${to.name} no tenía ${missingAtDest.map((c) => currencyLabel(c).toLowerCase()).join(" ni ")}: se los agrego al guardar.`}
        </p>
      )}

      <div className="space-y-1">
        <Label htmlFor="tr-date">Fecha</Label>
        <Input id="tr-date" type="date" className="h-12" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="space-y-1">
        <Label htmlFor="tr-desc">Descripción</Label>
        <Input
          id="tr-desc"
          className="h-12"
          placeholder="Opcional"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={submitting}>
        {submitting ? "Guardando…" : isCard ? "Registrar pago" : "Transferir"}
      </Button>
    </form>
  );
}
