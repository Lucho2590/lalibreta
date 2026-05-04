import {
  Banknote,
  Building,
  Building2,
  Coins,
  CreditCard,
  Landmark,
  type LucideIcon,
  PiggyBank,
  ShieldCheck,
  Smartphone,
  TrendingUp,
  Wallet,
} from "lucide-react";

export const ACCOUNT_ICONS: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: "wallet", label: "Billetera", icon: Wallet },
  { id: "banknote", label: "Efectivo", icon: Banknote },
  { id: "credit-card", label: "Tarjeta", icon: CreditCard },
  { id: "landmark", label: "Banco", icon: Landmark },
  { id: "building", label: "Banco", icon: Building },
  { id: "building-2", label: "Banco", icon: Building2 },
  { id: "piggy-bank", label: "Ahorro", icon: PiggyBank },
  { id: "coins", label: "Monedas", icon: Coins },
  { id: "smartphone", label: "Wallet digital", icon: Smartphone },
  { id: "trending-up", label: "Inversión", icon: TrendingUp },
  { id: "shield-check", label: "Seguro", icon: ShieldCheck },
];

const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  ACCOUNT_ICONS.map((c) => [c.id, c.icon]),
);

import type { AccountType } from "@/lib/domain/types";

export const defaultIconForType = (type: AccountType): string => {
  switch (type) {
    case "credit":
      return "credit-card";
    case "debit":
      return "wallet";
    case "cash":
      return "banknote";
    case "checking":
      return "landmark";
    case "savings":
      return "piggy-bank";
    case "digital":
      return "smartphone";
  }
};

export function AccountIcon({
  name,
  className,
}: {
  name?: string | null;
  className?: string;
}) {
  const Ico = (name && ICON_MAP[name]) || Wallet;
  return <Ico className={className} />;
}
