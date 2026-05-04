"use client";

import { useEffect, useMemo, useState } from "react";
import { Timestamp, addDoc, collection } from "firebase/firestore";
import {
  Banknote,
  CreditCard,
  Landmark,
  PiggyBank,
  Smartphone,
  Wallet,
} from "lucide-react";
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
import { useAuth } from "@/hooks/use-auth";
import { useAccounts } from "@/hooks/use-data";
import { db } from "@/lib/firebase/client";
import type { Account, AccountType } from "@/lib/domain/types";
import { ACCOUNT_ICONS, defaultIconForType } from "@/components/account-icon";
import { updateAccount } from "@/lib/domain/accounts";

const TYPE_OPTIONS: Array<{ value: AccountType; label: string; icon: typeof Wallet }> = [
  { value: "cash", label: "Efectivo", icon: Banknote },
  { value: "debit", label: "Débito", icon: Wallet },
  { value: "credit", label: "Crédito", icon: CreditCard },
  { value: "checking", label: "Cta. corriente", icon: Landmark },
  { value: "savings", label: "Caja de ahorro", icon: PiggyBank },
  { value: "digital", label: "Billetera virtual", icon: Smartphone },
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!iconTouched) setIcon(defaultIconForType(type));
  }, [type, iconTouched]);

  const hasChildren = useMemo(
    () => (account ? accounts.some((a) => a.parentId === account.id) : false),
    [accounts, account],
  );

  const eligibleParents = accounts.filter(
    (a) =>
      a.type !== "credit" &&
      !a.parentId &&
      a.active !== false &&
      a.id !== account?.id,
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name.trim()) return;
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
          patch.parentId = null;
          patch.defaultClosingDay = null;
          patch.defaultDueDay = null;
        }
        await updateAccount(user.uid, account.id, patch);
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
        }
        await addDoc(collection(db, `users/${user.uid}/accounts`), data);
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
        <div className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1">
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
                Para asociar esta tarjeta a un banco, primero creá una cuenta de
                tipo Efectivo o Débito.
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
