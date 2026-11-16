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
import { useUsdRate } from "@/hooks/use-usd-rate";
import { createTransactionWithInstallments } from "@/lib/domain/installments";
import { sortAccounts, updateAccount } from "@/lib/domain/accounts";
import { computeAccountBalances } from "@/lib/domain/balances";
import { exchangeDiffOf } from "@/lib/domain/exchanges";
import type { Account, Currency } from "@/lib/domain/types";
import { accountCurrencies } from "@/lib/domain/types";
import { formatAmountInput, formatMoney, parseAmount } from "@/lib/format";

const r2 = (n: number) => Math.round(n * 100) / 100;
const numberText = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Side = "sell" | "buy";

/** Ejemplos rápidos para "¿Dónde o con quién?". */
const WHO_HINTS = ["Mercado Pago", "Banco", "Cueva", "Familiar", "Amigo"];

/**
 * Cambio de moneda: vender o comprar dólares. Puede ser dentro de una misma
 * cuenta (salen dólares y entran pesos en Mercado Pago) o entre cuentas
 * (le vendí dólares billete a un amigo y me pasó los pesos a Mercado Pago).
 * Se escribe la cotización o los pesos que recibió/pagó; el otro se calcula.
 */
export function ExchangeForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: allInstallments } = useAllInstallments();
  const usdRate = useUsdRate();

  const [side, setSide] = useState<Side>("sell");
  const [usdInput, setUsdInput] = useState("");
  const [rateInput, setRateInput] = useState("");
  const [arsInput, setArsInput] = useState("");
  // Los pesos se calculan (dólares × cotización) hasta que el usuario los escribe:
  // desde ahí mandan los suyos (lo que realmente entró/salió).
  const [arsTouched, setArsTouched] = useState(false);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [who, setWho] = useState("");
  const [date, setDate] = useState(todayLocal);
  const [submitting, setSubmitting] = useState(false);

  const fromCurrency: Currency = side === "sell" ? "USD" : "ARS";
  const toCurrency: Currency = side === "sell" ? "ARS" : "USD";

  // Cuentas posibles: todas menos tarjetas. Las cobachas solo si ya tienen esa moneda
  // (son de una sola moneda). A una cuenta común sin esa moneda se le agrega al guardar.
  const usable = useMemo(
    () => sortAccounts(accounts.filter((a) => a.active !== false && a.type !== "credit")),
    [accounts],
  );
  const optionsFor = (c: Currency) =>
    usable.filter((a) => a.type !== "reserve" || accountCurrencies(a).includes(c));
  const has = (a: Account | undefined, c: Currency) => !!a && accountCurrencies(a).includes(c);

  const fromOptions = optionsFor(fromCurrency);
  const toOptions = optionsFor(toCurrency);

  // Por defecto: la principal (o la primera) que tenga la moneda que sale; entra
  // en la misma si maneja las dos, si no en la principal/primera con la otra moneda.
  const pickDefault = (list: Account[], c: Currency) =>
    list.find((a) => a.isMain && has(a, c)) ?? list.find((a) => has(a, c)) ?? list[0];
  const from = fromOptions.find((a) => a.id === fromId) ?? pickDefault(fromOptions, fromCurrency);
  const to =
    toOptions.find((a) => a.id === toId) ??
    (from && has(from, toCurrency) ? from : pickDefault(toOptions, toCurrency));

  const balances = useMemo(
    () => computeAccountBalances(usable, allInstallments),
    [usable, allInstallments],
  );
  const fromBalance = from ? balances.get(from.id)?.amounts[fromCurrency] : undefined;

  // Montos. La cotización es la pactada (o el oficial BCRA si no escribe nada);
  // los pesos son los que realmente se movieron. Si escribió las dos cosas y no
  // cierran (redondeo, comisión, el banco cambió de menos), la diferencia queda
  // registrada.
  const usd = parseAmount(usdInput) || 0;
  const typedRate = parseAmount(rateInput) || 0;
  const typedArs = parseAmount(arsInput) || 0;
  const quotedRate = typedRate || (arsTouched ? 0 : usdRate?.rate || 0);
  const ars = arsTouched ? r2(typedArs) : r2(usd * quotedRate);
  const rate = usd > 0 && ars > 0 ? r2(ars / usd) : quotedRate;
  const diff = typedRate > 0 && arsTouched && usd > 0 && ars > 0 ? exchangeDiffOf(side, usd, typedRate, ars) : 0;
  const usingBcra = !typedRate && !arsTouched && !!usdRate;
  const arsShown = arsTouched ? arsInput : usd > 0 && quotedRate > 0 ? numberText(ars) : "";

  const fromAmount = side === "sell" ? usd : ars;
  const toAmount = side === "sell" ? ars : usd;
  const missingFrom = from && !has(from, fromCurrency);
  const missingTo = to && !has(to, toCurrency);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!(usd > 0)) return toast.error("Ingresá cuántos dólares");
    if (!(rate > 0) || !(ars > 0)) return toast.error("Falta la cotización o los pesos");
    if (!from || !to) return toast.error("Elegí las cuentas");
    setSubmitting(true);
    try {
      // Si la cuenta no manejaba esa moneda, se la agregamos (ej. Mercado Pago con dólares).
      const additions = new Map<string, { acc: Account; add: Currency[] }>();
      for (const [acc, c] of [
        [from, fromCurrency],
        [to, toCurrency],
      ] as const) {
        if (has(acc, c)) continue;
        const entry = additions.get(acc.id) ?? { acc, add: [] };
        entry.add.push(c);
        additions.set(acc.id, entry);
      }
      for (const { acc, add } of additions.values()) {
        await updateAccount(user.uid, acc.id, { currencies: [...accountCurrencies(acc), ...add] });
      }
      const label = side === "sell" ? `Venta de ${formatMoney(usd, "USD")}` : `Compra de ${formatMoney(usd, "USD")}`;
      await createTransactionWithInstallments(user.uid, from, {
        accountId: from.id,
        toAccountId: to.id,
        categoryId: "",
        description: who.trim() ? `${label} · ${who.trim()}` : label,
        totalAmount: fromAmount,
        purchaseDate: new Date(`${date}T12:00:00`),
        kind: "transfer",
        installments: 1,
        currency: fromCurrency,
        toCurrency,
        toAmount,
        rate,
        ...(diff !== 0 ? { quotedRate: typedRate, exchangeDiff: diff } : {}),
        transferType: "exchange",
      });
      toast.success(
        `${side === "sell" ? "Vendiste" : "Compraste"} ${formatMoney(usd, "USD")} a ${formatMoney(rate, "ARS")}`,
        diff !== 0
          ? {
              description: `Diferencia registrada: ${diff > 0 ? "+" : "−"}${formatMoney(Math.abs(diff), "ARS")} ${diff > 0 ? "a favor" : "en contra"}`,
            }
          : undefined,
      );
      setUsdInput("");
      setArsInput("");
      setRateInput("");
      setArsTouched(false);
      setWho("");
      onSubmitted?.();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar el cambio");
    } finally {
      setSubmitting(false);
    }
  };

  const accountSelect = (
    label: string,
    value: Account | undefined,
    options: Account[],
    c: Currency,
    onChange: (id: string) => void,
  ) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value?.id ?? ""} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger className="h-12 w-full">
          <SelectValue
            placeholder="Elegí una cuenta"
            items={options.map((a) => ({ value: a.id, label: a.name }))}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
              {!has(a, c) && (
                <span className="text-muted-foreground">
                  {" "}
                  · sin {c === "USD" ? "dólares" : "pesos"}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
        {(
          [
            { value: "sell", label: "Vendí dólares" },
            { value: "buy", label: "Compré dólares" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              setSide(opt.value);
              setArsTouched(false);
              setArsInput("");
              setFromId("");
              setToId("");
            }}
            className={`h-9 rounded-lg text-sm font-medium transition ${
              side === opt.value ? "bg-background shadow-sm" : "text-muted-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <Label htmlFor="ex-usd">{side === "sell" ? "Dólares que vendiste" : "Dólares que compraste"}</Label>
        <Input
          id="ex-usd"
          inputMode="decimal"
          autoComplete="off"
          placeholder="US$ 0"
          className="h-12 text-lg"
          value={usdInput}
          onChange={(e) => setUsdInput(e.target.value)}
          onBlur={(e) => setUsdInput(formatAmountInput(e.target.value))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="ex-rate">Cotización</Label>
          <Input
            id="ex-rate"
            inputMode="decimal"
            autoComplete="off"
            className="h-11"
            placeholder={usdRate ? numberText(usdRate.rate) : "Ej: 1.480"}
            value={rateInput}
            onChange={(e) => setRateInput(e.target.value)}
            onBlur={(e) => setRateInput(formatAmountInput(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ex-ars">{side === "sell" ? "Pesos que recibiste" : "Pesos que pagaste"}</Label>
          <Input
            id="ex-ars"
            inputMode="decimal"
            autoComplete="off"
            className="h-11"
            placeholder="$ 0"
            value={arsShown}
            onChange={(e) => {
              setArsInput(e.target.value);
              setArsTouched(true);
            }}
            onBlur={(e) => arsTouched && setArsInput(formatAmountInput(e.target.value))}
          />
        </div>
      </div>
      <div className="-mt-2 space-y-1 text-xs text-muted-foreground">
        {usingBcra ? (
          <p>
            Usando el oficial BCRA ({numberText(usdRate!.rate)}). Escribí la cotización a la que
            cambiaste y, si te {side === "sell" ? "entró" : "cobraron"} otro monto, corregí los pesos.
          </p>
        ) : !arsTouched ? (
          <p>
            Pesos = dólares × cotización. Si te {side === "sell" ? "entró" : "cobraron"} otro monto
            (redondeo, comisión), corregilo.
          </p>
        ) : !typedRate && rate > 0 ? (
          <p>Cotización efectiva: {formatMoney(rate, "ARS")}.</p>
        ) : null}
        {arsTouched && (
          <button
            type="button"
            className="font-medium text-brand hover:underline"
            onClick={() => {
              setArsTouched(false);
              setArsInput("");
            }}
          >
            Recalcular pesos
          </button>
        )}
      </div>
      {diff !== 0 && (
        <div
          className={`rounded-xl px-3 py-2 text-xs ${
            diff < 0 ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"
          }`}
        >
          <span className="font-semibold">
            Diferencia: {diff > 0 ? "+" : "−"}
            {formatMoney(Math.abs(diff), "ARS")} {diff > 0 ? "a favor" : "en contra"}
          </span>{" "}
          contra {formatMoney(usd, "USD")} × {formatMoney(typedRate, "ARS")} ={" "}
          {formatMoney(r2(usd * typedRate), "ARS")}. Queda registrada en el cambio (cotización
          efectiva {formatMoney(rate, "ARS")}).
        </div>
      )}

      <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
        {accountSelect(
          side === "sell" ? "Salen los dólares de" : "Salen los pesos de",
          from,
          fromOptions,
          fromCurrency,
          setFromId,
        )}
        {from && fromBalance !== undefined && has(from, fromCurrency) && (
          <p className="-mt-2 text-xs text-muted-foreground">
            Tenés {formatMoney(fromBalance, fromCurrency)} en {from.name}
          </p>
        )}
        <div className="flex justify-center">
          <ArrowDown className="size-4 text-muted-foreground" />
        </div>
        {accountSelect(
          side === "sell" ? "Entran los pesos en" : "Entran los dólares en",
          to,
          toOptions,
          toCurrency,
          setToId,
        )}
        {(missingFrom || missingTo) && (
          <p className="text-xs text-muted-foreground">
            {[
              missingFrom && from ? `${from.name} no tiene ${fromCurrency === "USD" ? "dólares" : "pesos"}` : null,
              missingTo && to ? `${to.name} no tiene ${toCurrency === "USD" ? "dólares" : "pesos"}` : null,
            ]
              .filter(Boolean)
              .join(" y ")}
            : se ${missingFrom && missingTo ? "los agrego" : "lo agrego"} al guardar.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="ex-who">¿Dónde o con quién?</Label>
        <Input
          id="ex-who"
          className="h-12"
          placeholder="Opcional: Mercado Pago, mi señora, un amigo…"
          value={who}
          onChange={(e) => setWho(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5 pt-1">
          {WHO_HINTS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setWho(h)}
              className={`rounded-full border px-2.5 py-1 text-xs transition ${
                who === h ? "border-transparent bg-brand text-brand-foreground" : "bg-background hover:bg-muted"
              }`}
            >
              {h}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="ex-date">Fecha</Label>
        <Input id="ex-date" type="date" className="h-12" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      {usd > 0 && ars > 0 && (
        <div className="rounded-xl bg-brand/5 p-3 text-sm">
          <span className="font-semibold">{formatMoney(fromAmount, fromCurrency)}</span>
          {from && <span className="text-muted-foreground"> de {from.name}</span>} →{" "}
          <span className="font-semibold">{formatMoney(toAmount, toCurrency)}</span>
          {to && <span className="text-muted-foreground"> en {to.name}</span>}
          <div className="text-xs text-muted-foreground">
            a {formatMoney(rate, "ARS")} por dólar
            {diff !== 0 && ` (pactado ${formatMoney(typedRate, "ARS")})`}
          </div>
        </div>
      )}

      <Button
        type="submit"
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        disabled={submitting}
      >
        {submitting ? "Guardando…" : "Guardar cambio"}
      </Button>
    </form>
  );
}
