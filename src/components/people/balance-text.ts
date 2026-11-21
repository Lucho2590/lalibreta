import { ledgerNow, type PersonLedger } from "@/lib/domain/debts";
import type { Currency } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

const CURS: Currency[] = ["ARS", "USD"];

/**
 * Lo de AHORA con una persona ("Te debe $X" / "Le debés $X" / "Están al
 * día") y, aparte, lo de las cuotas que vienen.
 */
export function personBalanceText(l: PersonLedger) {
  const rows = CURS.map((c) => ({ c, ...ledgerNow(l, c) }));
  const fmt = (xs: Array<{ c: Currency; v: number }>) => xs.map((p) => formatMoney(Math.abs(p.v), p.c)).join(" + ");
  const now = rows.filter((r) => Math.abs(r.now) > 0.009).map((r) => ({ c: r.c, v: r.now }));
  const laterToMe = rows.filter((r) => r.later > 0.009).map((r) => ({ c: r.c, v: r.later }));
  const laterIOwe = rows.filter((r) => r.later < -0.009).map((r) => ({ c: r.c, v: r.later }));
  const later = [
    laterToMe.length ? `${fmt(laterToMe)} de cuotas que vienen` : null,
    laterIOwe.length ? `vos le debés ${fmt(laterIOwe)} de cuotas que vienen` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const owes = now.filter((p) => p.v > 0);
  const iOwe = now.filter((p) => p.v < 0);
  // Los montos por separado (en valor absoluto), para mostrarlos animados.
  const toRecord = (xs: Array<{ c: Currency; v: number }>) =>
    Object.fromEntries(xs.map((p) => [p.c, Math.abs(p.v)])) as Partial<Record<Currency, number>>;
  const amounts = {
    owes: toRecord(owes),
    iOwe: toRecord(iOwe),
    laterToMe: toRecord(laterToMe),
    laterIOwe: toRecord(laterIOwe),
  };
  if (!now.length) return { text: later ? "Al día" : "Están a mano", tone: "muted" as const, later, kind: "settled" as const, amounts };
  if (owes.length && !iOwe.length) return { text: `Te debe ${fmt(owes)}`, tone: "success" as const, later, kind: "owes" as const, amounts };
  if (iOwe.length && !owes.length) return { text: `Le debés ${fmt(iOwe)}`, tone: "destructive" as const, later, kind: "iOwe" as const, amounts };
  return { text: `Te debe ${fmt(owes)} · le debés ${fmt(iOwe)}`, tone: "muted" as const, later, kind: "both" as const, amounts };
}

export type PersonBalance = ReturnType<typeof personBalanceText>;
