"use client";

import { useEffect, useMemo, useState } from "react";
import { Timestamp, addDoc, collection } from "firebase/firestore";
import {
  Banknote,
  CreditCard,
  Landmark,
  Coins,
  PiggyBank,
  Smartphone,
  Wallet,
} from "lucide-react";
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
import { useAuth } from "@/hooks/use-auth";
import { useAccounts } from "@/hooks/use-data";
import { db } from "@/lib/firebase/client";
import type { Account, AccountType, Currency } from "@/lib/domain/types";
import { ACCOUNT_ICONS, defaultIconForType } from "@/components/account-icon";
import { clearOtherMainAccounts, updateAccount } from "@/lib/domain/accounts";

const TYPE_OPTIONS: Array<{ value: AccountType; label: string; icon: typeof Wallet }> = [
  { value: "cash", label: "Efectivo", icon: Banknote },
  { value: "debit", label: "Débito", icon: Wallet },
  { value: "credit", label: "Crédito", icon: CreditCard },
  { value: "checking", label: "Cta. corriente", icon: Landmark },
  { value: "savings", label: "Caja de ahorro", icon: PiggyBank },
  { value: "digital", label: "Billetera virtual", icon: Smartphone },
  { value: "reserve", label: "Cobacha", icon: Coins },
];

export function AccountForm({
  account,
  onCreated,
  onUpdated,
}: {
  account?: Account;
  onCreated?: () => void;
  onUpdated?: () => void;
}) {
  const isEdit = !!account;
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "cash");
  const [icon, setIcon] = useState<string>(
    account?.icon ?? defaultIconForType(account?.type ?? "cash"),
  );
  const [iconTouched, setIconTouched] = useState(isEdit);
  const [closingDay, setClosingDay] = useState(account?.defaultClosingDay ?? 25);
  const [dueDay, setDueDay] = useState(account?.defaultDueDay ?? 5);
  const [parentId, setParentId] = useState<string>(account?.parentId ?? "");
  const [currencies, setCurrencies] = useState<Currency[]>(
    account?.currencies?.length ? account.currencies : ["ARS"],
  );
  const [isMain, setIsMain] = useState<boolean>(account?.isMain ?? false);
  const [openingARS, setOpeningARS] = useState(
    account?.openingBalances?.ARS ? String(account.openingBalances.ARS) : "",
  );
  const [openingUSD, setOpeningUSD] = useState(
    account?.openingBalances?.USD ? String(account.openingBalances.USD) : "",
  );
  const [busy, setBusy] = useState(false);

  // Las cobachas tienen una sola moneda: elegir una reemplaza a la otra.
  const toggleCurrency = (c: Currency) =>
    setCurrencies((prev) =>
      type === "reserve"
        ? [c]
        : prev.includes(c)
          ? prev.length > 1
            ? prev.filter((x) => x !== c)
            : prev
          : [...prev, c],
    );

  /** Monedas, principal y saldo inicial (solo cuentas que no son tarjeta). */
  const moneyFields = (): Record<string, unknown> => {
    const effCurrencies: Currency[] = type === "reserve" ? [currencies[0]] : currencies;
    const opening: Partial<Record<Currency, number>> = {};
    const ars = Number(openingARS.replace(",", "."));
    const usd = Number(openingUSD.replace(",", "."));
    if (effCurrencies.includes("ARS") && ars) opening.ARS = ars;
    if (effCurrencies.includes("USD") && usd) opening.USD = usd;
    const hasOpening = Object.keys(opening).length > 0;
    return {
      currencies: effCurrencies,
      isMain: type === "reserve" ? false : isMain,
      openingBalances: hasOpening ? opening : null,
      openingDate: hasOpening ? (account?.openingDate ?? Timestamp.now()) : null,
    };
  };

  useEffect(() => {
    if (!iconTouched) setIcon(defaultIconForType(type));
  }, [type, iconTouched]);

  const hasChildren = useMemo(
    () => (account ? accounts.some((a) => a.parentId === account.id) : false),
    [accounts, account],
  );

  const isReserve = type === "reserve";
  const eligibleParents = accounts.filter(
    (a) =>
      a.type !== "credit" &&
      a.type !== "reserve" &&
      !a.parentId &&
      a.active !== false &&
      a.id !== account?.id,
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name.trim()) return;
    if (isReserve && !parentId) {
      toast.error("Elegí en qué cuenta está la cobacha");
      return;
    }
    setBusy(true);
    try {
      if (isEdit && account) {
        const patch: Record<string, unknown> = {
          name: name.trim(),
          type,
          icon,
        };
        if (type === "credit") {
          patch.defaultClosingDay = Math.min(31, Math.max(1, closingDay));
          patch.defaultDueDay = Math.min(31, Math.max(1, dueDay));
          patch.parentId = parentId || null;
        } else {
          patch.parentId = isReserve ? parentId || null : null;
          patch.defaultClosingDay = null;
          patch.defaultDueDay = null;
          Object.assign(patch, moneyFields());
        }
        await updateAccount(user.uid, account.id, patch);
        if (type !== "credit" && isMain) await clearOtherMainAccounts(user.uid, account.id);
        toast.success("Cuenta actualizada");
        onUpdated?.();
      } else {
        const data: Record<string, unknown> = {
          name: name.trim(),
          type,
          icon,
          active: true,
          createdAt: Timestamp.now(),
        };
        if (type === "credit") {
          data.defaultClosingDay = Math.min(31, Math.max(1, closingDay));
          data.defaultDueDay = Math.min(31, Math.max(1, dueDay));
          if (parentId) data.parentId = parentId;
        } else {
          Object.assign(data, moneyFields());
          if (isReserve) data.parentId = parentId;
        }
        const ref = await addDoc(collection(db, `users/${user.uid}/accounts`), data);
        if (type !== "credit" && isMain) await clearOtherMainAccounts(user.uid, ref.id);
        toast.success("Cuenta creada");
        setName("");
        setIconTouched(false);
        setParentId("");
        onCreated?.();
      }
    } catch (err) {
      toast.error(isEdit ? "No se pudo actualizar" : "No se pudo crear");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label>Tipo</Label>
        <div className="grid grid-cols-4 gap-1 rounded-2xl bg-muted p-1">
          {TYPE_OPTIONS.map((opt) => {
            const Ico = opt.icon;
            const selected = type === opt.value;
            const disabled = hasChildren && opt.value === "credit";
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                title={disabled ? "Esta cuenta tiene tarjetas asociadas" : opt.label}
                onClick={() => setType(opt.value)}
                className={`flex h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium leading-tight transition ${
                  selected ? "bg-background shadow-sm" : "text-muted-foreground"
                } ${disabled ? "opacity-40" : ""}`}
              >
                <Ico className="size-4" />
                <span className="text-center">{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="acc-name">Nombre</Label>
        <Input
          id="acc-name"
          className="h-12"
          placeholder="Ej: Visa Galicia, Efectivo"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {isReserve && (
        <div className="space-y-1.5">
          <Label>¿En qué cuenta está?</Label>
          {eligibleParents.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
              Primero creá la cuenta donde está la cobacha (Mercado Pago, Naranja X, tu banco…).
            </p>
          ) : (
            <Select value={parentId} onValueChange={(v) => setParentId(v ?? "")}>
              <SelectTrigger className="h-12 w-full">
                <SelectValue
                  placeholder="Elegí la cuenta"
                  items={eligibleParents.map((a) => ({ value: a.id, label: a.name }))}
                />
              </SelectTrigger>
              <SelectContent>
                {eligibleParents.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-muted-foreground">
            Las reservas de Mercado Pago o los frascos de Naranja X. Guardar o sacar plata es una
            transferencia con su cuenta.
          </p>
        </div>
      )}

      {type !== "credit" && (
        <div className="space-y-4 rounded-2xl border p-3">
          <div className="space-y-1.5">
            <Label>{isReserve ? "Moneda" : "Monedas"}</Label>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
              {(["ARS", "USD"] as Currency[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCurrency(c)}
                  className={`h-10 rounded-lg text-sm font-medium transition ${
                    currencies.includes(c) ? "bg-background shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  {c === "ARS" ? "$ Pesos" : "US$ Dólares"}
                </button>
              ))}
            </div>
            {!isReserve && (
              <p className="text-xs text-muted-foreground">
                Un banco con caja de ahorro en pesos y en dólares lleva las dos.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {currencies.includes("ARS") && (
              <div className="space-y-1.5">
                <Label htmlFor="op-ars">Saldo actual $</Label>
                <Input
                  id="op-ars"
                  inputMode="decimal"
                  className="h-11"
                  placeholder="0"
                  value={openingARS}
                  onChange={(e) => setOpeningARS(e.target.value)}
                />
              </div>
            )}
            {currencies.includes("USD") && (
              <div className="space-y-1.5">
                <Label htmlFor="op-usd">Saldo actual US$</Label>
                <Input
                  id="op-usd"
                  inputMode="decimal"
                  className="h-11"
                  placeholder="0"
                  value={openingUSD}
                  onChange={(e) => setOpeningUSD(e.target.value)}
                />
              </div>
            )}
          </div>

          {!isReserve && (
          <div className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium">Cuenta principal</span>
              <span className="block text-xs text-muted-foreground">
                Donde cobrás. El agente la usa por defecto para ingresos, cambios y pagos de tarjeta.
              </span>
            </span>
            <Switch
              checked={isMain}
              onCheckedChange={(v) => setIsMain(Boolean(v))}
              aria-label="Cuenta principal"
            />
          </div>
          )}
        </div>
      )}

      {type === "credit" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="closing">Día de cierre</Label>
              <Input
                id="closing"
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                className="h-12"
                value={closingDay}
                onChange={(e) => setClosingDay(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="due">Día de vencimiento</Label>
              <Input
                id="due"
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                className="h-12"
                value={dueDay}
                onChange={(e) => setDueDay(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Cuenta asociada (opcional)</Label>
            {eligibleParents.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                Para asociar esta tarjeta a un banco, primero creá la cuenta del
                banco (por ejemplo, tu cuenta principal).
              </p>
            ) : (
              <Select
                value={parentId || "__none__"}
                onValueChange={(v) => setParentId(v === "__none__" ? "" : v ?? "")}
              >
                <SelectTrigger className="h-12 w-full">
                  <SelectValue
                    placeholder="Sin cuenta padre"
                    items={[
                      { value: "__none__", label: "Sin cuenta padre" },
                      ...eligibleParents.map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sin cuenta padre</SelectItem>
                  {eligibleParents.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              Por ejemplo: Visa Galicia → cuenta Banco Galicia.
            </p>
          </div>
        </>
      )}

      <div className="space-y-1.5">
        <Label>Ícono</Label>
        <div className="grid grid-cols-6 gap-1.5 rounded-xl border p-2">
          {ACCOUNT_ICONS.map((it) => {
            const Ico = it.icon;
            const selected = icon === it.id;
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => {
                  setIcon(it.id);
                  setIconTouched(true);
                }}
                title={it.label}
                className={`flex aspect-square items-center justify-center rounded-lg transition ${
                  selected ? "bg-brand text-brand-foreground" : "hover:bg-muted"
                }`}
              >
                <Ico className="size-5" />
              </button>
            );
          })}
        </div>
      </div>

      <Button
        className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
        type="submit"
        disabled={busy || !name.trim()}
      >
        {busy ? "Guardando…" : isEdit ? "Guardar cambios" : "Crear cuenta"}
      </Button>
    </form>
  );
}
