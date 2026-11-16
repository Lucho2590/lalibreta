import { ledgerTotal, type PersonLedger } from "@/lib/domain/debts";
import type { Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

const CURS: Currency[] = ["ARS", "USD"];

/** "Te debe $X" / "Le debés $X" / "Están a mano", por moneda. */
export function personBalanceText(l: PersonLedger) {
  const parts = CURS.map((c) => ({ c, t: ledgerTotal(l, c) })).filter((x) => Math.abs(x.t) > 0.009);
  if (parts.length === 0) return { text: "Están a mano", tone: "muted" as const };
  const owes = parts.filter((p) => p.t > 0);
  const iOwe = parts.filter((p) => p.t < 0);
  const fmt = (xs: typeof parts) => xs.map((p) => formatMoney(Math.abs(p.t), p.c)).join(" + ");
  if (owes.length && !iOwe.length) return { text: `Te debe ${fmt(owes)}`, tone: "success" as const };
  if (iOwe.length && !owes.length) return { text: `Le debés ${fmt(iOwe)}`, tone: "destructive" as const };
  return { text: `Te debe ${fmt(owes)} · le debés ${fmt(iOwe)}`, tone: "muted" as const };
}

