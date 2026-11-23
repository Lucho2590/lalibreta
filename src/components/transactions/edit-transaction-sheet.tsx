"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Timestamp, addDoc, collection, doc, getDoc } from "firebase/firestore";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CategorySelect } from "@/components/category-select";
import { useAccounts, useCategories, useRecurring } from "@/hooks/use-data";
import { useAuth } from "@/hooks/use-auth";
import { db } from "@/lib/firebase/client";
import { apiPost } from "@/lib/api";
import { sortAccounts } from "@/lib/domain/accounts";
import { transactionsCollectionPath, updateTransaction } from "@/lib/domain/installments";
import { normalizeMerchant } from "@/lib/domain/merchants";
import { recurringCollectionPath } from "@/lib/domain/recurring";
import type { Currency, Installment, Transaction } from "@/lib/domain/types";
import { accountCurrencies, monthOf } from "@/lib/domain/types";
import type { SplitTxInfo } from "@/lib/domain/debts";
import { currencyOptionLabel, formatAmountInput, formatMoney, parseAmount } from "@/lib/format";

const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const num = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
const INSTALLMENT_OPTIONS = [1, 3, 6, 9, 12, 18, 24];

/** Editar un gasto o ingreso ya cargado (monto, descripción, categoría, cuenta, fecha, cuotas). */
export function EditTransactionSheet({
  item,
  split,
  onClose,
}: {
  item: Installment | null;
  /** Si el gasto está dividido con otras personas. */
  split?: SplitTxInfo;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const { data: categories } = useCategories();
  const { data: recurring } = useRecurring();
  const [tx, setTx] = useState<Transaction | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [currency, setCurrency] = useState<Currency>("ARS");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState("");
  const [installments, setInstallments] = useState(1);
  const [cardClosed, setCardClosed] = useState(false);
  // "Se repite todos los meses": lo da de alta como fijo.
  const [repeats, setRepeats] = useState(false);
  const [fijoName, setFijoName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!item || !user) return;
    let alive = true;
    getDoc(doc(db, transactionsCollectionPath(user.uid), item.transactionId)).then((snap) => {
      if (!alive || !snap.exists()) return;
      const t = { id: snap.id, ...(snap.data() as Omit<Transaction, "id">) };
      setTx(t);
      setAmountInput(num(t.totalAmount));
      setCurrency(t.currency ?? "ARS");
      setDescription(t.description ?? "");
      setCategoryId(t.categoryId || null);
      setAccountId(t.accountId);
      setDate(ymdLocal(t.purchaseDate.toDate()));
      setInstallments(Math.max(1, t.installments ?? 1));
      setCardClosed(!!t.cardClosedAtPurchase);
      setRepeats(false);
      setFijoName("");
    });
    return () => {
      alive = false;
    };
  }, [item, user]);

  const kind = tx?.kind === "income" ? "income" : "expense";
  const options = useMemo(
    () => sortAccounts(accounts.filter((a) => a.active !== false || a.id === accountId)),
    [accounts, accountId],
  );
  const account = accounts.find((a) => a.id === accountId);
  const currencies: Currency[] = account ? accountCurrencies(account) : ["ARS", "USD"];
  const effCurrency = currencies.includes(currency) ? currency : currencies[0];
  const isCredit = account?.type === "credit" && kind === "expense";
  const cats = categories.filter((c) => c.kind === kind || (account?.type === "credit" && c.kind === "expense"));
  const amount = parseAmount(amountInput) || 0;
  const fijo = tx?.recurringId ? recurring.find((r) => r.id === tx.recurringId) : undefined;
  // Un gasto o ingreso de un pago (no cuotas ni estimados) se puede volver fijo.
  const canRepeat =
    !!tx && !item?.projected && tx.kind !== "transfer" && !(isCredit && installments > 1);

  if (!item) return null;

  const save = async () => {
    if (!user || !tx || !account) return;
    if (!(amount > 0)) return toast.error("Ingresá un monto");
    if (!categoryId) return toast.error("Elegí una categoría");
    setBusy(true);
    try {
      // Se repite todos los meses: fijo nuevo, enganchado a este movimiento
      // (así no se ofrece aplicarlo de nuevo este mes). En una tarjeta guarda
      // cómo figura en el resumen, para reconocerlo solo en los próximos.
      let recurringId = tx.recurringId;
      const makeFijo = canRepeat && repeats && !recurringId;
      if (makeFijo) {
        const ref = await addDoc(collection(db, recurringCollectionPath(user.uid)), {
          name: (fijoName.trim() || description.trim()).slice(0, 60),
          amount,
          currency: effCurrency,
          accountId: account.id,
          categoryId,
          kind,
          dayOfMonth: Number(date.slice(8, 10)) || 1,
          // Los fijos van por mes de pago (con tarjeta, el del vencimiento).
          startMonth: monthOf(item),
          endMonth: null,
          active: true,
          matchKey: account.type === "credit" && tx.description ? normalizeMerchant(tx.description) : null,
          createdAt: Timestamp.now(),
        });
        recurringId = ref.id;
      }
      await updateTransaction(user.uid, account, tx.id, {
        accountId: account.id,
        categoryId,
        description: description.trim(),
        totalAmount: amount,
        purchaseDate: new Date(`${date}T12:00:00`),
        kind,
        installments: isCredit ? installments : 1,
        cardClosedAtPurchase: isCredit ? cardClosed : false,
        currency: effCurrency,
        ...(recurringId ? { recurringId } : {}),
        ...(item.projected ? { projected: true } : {}),
        ...(item.createdByName ? { createdByName: item.createdByName } : {}),
      });
      // Gasto dividido: se recalculan las partes y se les avisa.
      if (split) await apiPost("/api/splits/resync", { txIds: [tx.id] });
      toast.success(
        makeFijo
          ? `Listo: quedó en Fijos${account.type === "credit" ? " y lo reconozco solo en los próximos resúmenes" : ""}`
          : split
            ? "Gasto actualizado (y el reparto)"
            : "Gasto actualizado",
      );
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>Editar {kind === "income" ? "ingreso" : "gasto"}</SheetTitle>
        </SheetHeader>
        {!tx ? (
          <p className="px-5 pb-6 text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="space-y-4 px-5 pb-6 pt-2">
            <div className="space-y-1">
              <Label htmlFor="ed-amount">Monto{isCredit && installments > 1 ? " total (todas las cuotas)" : ""}</Label>
              <Input
                id="ed-amount"
                inputMode="decimal"
                className="h-12 text-lg"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                onBlur={(e) => setAmountInput(formatAmountInput(e.target.value))}
              />
              {currencies.length > 1 && (
                <div className="mt-1.5 inline-flex flex-wrap rounded-lg bg-muted p-0.5">
                  {currencies.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCurrency(c)}
                      className={`h-8 rounded-md px-3 text-xs font-medium transition ${effCurrency === c ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                    >
                      {currencyOptionLabel(c)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="ed-desc">Descripción</Label>
              <Input id="ed-desc" className="h-12" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Cuenta</Label>
                <Select value={accountId} onValueChange={(v) => setAccountId(v ?? accountId)}>
                  <SelectTrigger className="h-12 w-full">
                    <SelectValue items={options.map((a) => ({ value: a.id, label: a.name }))} />
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
              <div className="space-y-1">
                <Label>Categoría</Label>
                <CategorySelect value={categoryId} onChange={setCategoryId} groups={[{ categories: cats }]} placeholder="Elegí…" />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ed-date">Fecha</Label>
              <Input id="ed-date" type="date" className="h-12" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>

            {isCredit && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                <div className="space-y-1">
                  <Label>Cuotas</Label>
                  <div className="flex flex-wrap gap-2">
                    {INSTALLMENT_OPTIONS.map((n) => (
                      <button
                        type="button"
                        key={n}
                        onClick={() => setInstallments(n)}
                        className={`min-w-10 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                          installments === n ? "border-transparent bg-brand text-brand-foreground" : "bg-background hover:bg-muted"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="ed-closed" className="text-sm">¿La tarjeta ya estaba cerrada?</Label>
                  <Switch id="ed-closed" checked={cardClosed} onCheckedChange={setCardClosed} />
                </div>
              </div>
            )}

            {canRepeat &&
              (tx.recurringId ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
                  <span>🔁 Es un fijo{fijo ? `: ${fijo.name}` : ""}</span>
                  <Link href="/fijos" onClick={onClose} className="shrink-0 text-xs font-medium text-brand underline">
                    Ver en Fijos
                  </Link>
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="ed-repeat" className="text-sm">
                        Se repite todos los meses
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Queda en Fijos
                        {account?.type === "credit" ? " y lo reconozco solo en los próximos resúmenes de la tarjeta" : ""}.
                      </p>
                    </div>
                    <Switch id="ed-repeat" checked={repeats} onCheckedChange={setRepeats} />
                  </div>
                  {repeats && (
                    <div className="space-y-1">
                      <Label htmlFor="ed-fijo-name">Nombre del fijo</Label>
                      <Input
                        id="ed-fijo-name"
                        className="h-12"
                        placeholder={description || "Ej. Prepaga"}
                        value={fijoName}
                        onChange={(e) => setFijoName(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              ))}

            {split && (
              <p className="rounded-lg bg-brand/5 p-3 text-xs">
                Está dividido con {split.split.participants.map((p) => p.name.split(" ")[0]).join(", ")}. Si cambiás el monto, las
                partes en % se recalculan y les avisamos{split.acceptedCount > 0 ? " (lo que ya aceptaron sigue aceptado)" : ""}.
                {amount > 0 &&
                  split.split.participants.some((p) => p.shareType === "percent") &&
                  ` Ej.: ${split.split.participants
                    .filter((p) => p.shareType === "percent")
                    .map((p) => `${p.name.split(" ")[0]} pasaría a ${formatMoney(Math.round(amount * (p.percent ?? 0)) / 100, effCurrency)}`)
                    .join(", ")}.`}
              </p>
            )}
            {item.projected && (
              <p className="text-xs text-muted-foreground">
                Es un estimado: cuando cargues el resumen real, se reemplaza por el monto del resumen.
              </p>
            )}

            <Button className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={busy} onClick={save}>
              {busy ? "Guardando…" : "Guardar cambios"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
