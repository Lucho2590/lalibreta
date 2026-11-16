import type { Currency } from "./types";
import {
  participantSchedule,
  transferSide,
  userRef,
  type PersonRef,
  type PersonTransfer,
  type Split,
} from "./people";

/**
 * Cuentas con gente (puro, lo usan la web y el agente):
 * - computePeopleLedger: cuánto me debe (o le debo) a cada persona, por moneda.
 * - buildSplitAdjustment: cuánto de cada gasto repartido es realmente mío.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const zero = (): Record<Currency, number> => ({ ARS: 0, USD: 0 });

export interface LedgerEntry {
  kind: "split" | "transfer";
  /** splitId o transferId. */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  paymentMonth: string;
  description: string;
  /** + = me debe; − = le debo / me pagó. */
  amount: number;
  currency: Currency;
  /** Cuota que todavía no venció. */
  future: boolean;
}

export interface PersonLedger {
  ref: PersonRef;
  name: string;
  /** Usa la app (u:) o es un contacto sin app (c:). */
  isApp: boolean;
  /** Por moneda: lo que ya venció (due) y las cuotas que vienen (upcoming). + = me debe. */
  due: Record<Currency, number>;
  upcoming: Record<Currency, number>;
  entries: LedgerEntry[];
}

export interface LedgerInput {
  me: string;
  /** Repartos donde participo (como dueño o como participante). */
  splits: Split[];
  /** Transferencias con personas donde participo. */
  transfers: PersonTransfer[];
  /** Mes actual (YYYY-MM): lo de meses posteriores es "upcoming". */
  nowMonth: string;
}

export const computePeopleLedger = ({ me, splits, transfers, nowMonth }: LedgerInput): Map<PersonRef, PersonLedger> => {
  const out = new Map<PersonRef, PersonLedger>();
  const get = (ref: PersonRef, name: string) => {
    let l = out.get(ref);
    if (!l) {
      l = { ref, name, isApp: ref.startsWith("u:"), due: zero(), upcoming: zero(), entries: [] };
      out.set(ref, l);
    }
    if (name && (!l.name || l.name === "Alguien")) l.name = name;
    return l;
  };
  const add = (l: PersonLedger, e: LedgerEntry) => {
    l.entries.push(e);
    const bucket = e.future ? l.upcoming : l.due;
    bucket[e.currency] = round2(bucket[e.currency] + e.amount);
  };

  for (const s of splits) {
    if (s.status !== "active") continue;
    if (s.ownerUid === me) {
      for (const p of s.participants) {
        if (p.status !== "accepted" && p.status !== "offline") continue;
        const l = get(p.ref, p.name);
        for (const c of participantSchedule(s, p.amount)) {
          add(l, {
            kind: "split",
            id: s.id,
            date: c.date,
            paymentMonth: c.paymentMonth,
            description: s.description,
            amount: c.amount,
            currency: s.currency,
            future: c.paymentMonth > nowMonth,
          });
        }
      }
    } else {
      const mine = s.participants.find((p) => p.uid === me);
      if (!mine || mine.status !== "accepted") continue;
      const l = get(userRef(s.ownerUid), s.ownerName);
      for (const c of participantSchedule(s, mine.amount)) {
        add(l, {
          kind: "split",
          id: s.id,
          date: c.date,
          paymentMonth: c.paymentMonth,
          description: s.description,
          amount: -c.amount,
          currency: s.currency,
          future: c.paymentMonth > nowMonth,
        });
      }
    }
  }

  for (const t of transfers) {
    if (t.status !== "accepted") continue;
    const side = transferSide(t, me);
    if (!side) continue;
    const l = get(side.person, side.name);
    add(l, {
      kind: "transfer",
      id: t.id,
      date: t.date,
      paymentMonth: t.date.slice(0, 7),
      description: t.description,
      // Le pasé plata → me debe más; me pasó → me debe menos.
      amount: side.direction === "out" ? t.amount : -t.amount,
      currency: t.currency,
      future: false,
    });
  }

  for (const l of out.values()) l.entries.sort((a, b) => b.date.localeCompare(a.date));
  return out;
};

/** Neto total con una persona en una moneda (vencido + cuotas que vienen). */
export const ledgerTotal = (l: PersonLedger, c: Currency) => round2(l.due[c] + l.upcoming[c]);

/** Totales: lo que me deben y lo que debo, por moneda (sobre el neto de cada persona). */
export const ledgerTotals = (ledger: Iterable<PersonLedger>) => {
  const owedToMe = zero();
  const iOwe = zero();
  for (const l of ledger) {
    for (const c of ["ARS", "USD"] as const) {
      const t = ledgerTotal(l, c);
      if (t > 0.009) owedToMe[c] = round2(owedToMe[c] + t);
      else if (t < -0.009) iOwe[c] = round2(iOwe[c] - t);
    }
  }
  return { owedToMe, iOwe };
};

// === Cuánto de cada gasto repartido es mío ===

export interface SplitTxInfo {
  split: Split;
  /** Parte que es mía (0..1): se aplica a cada cuota del gasto. */
  factor: number;
  acceptedCount: number;
  pendingCount: number;
  rejectedCount: number;
  offlineCount: number;
  othersCount: number;
}

/**
 * Lo que cada contacto sin app ya me devolvió de cada reparto. Sus pagos se
 * imputan a lo más viejo que me debe (repartos y préstamos, por fecha).
 */
export const recoveredOfflineShares = (
  me: string,
  splits: Split[],
  transfers: PersonTransfer[],
): Map<string, number> => {
  // Por contacto y moneda: deudas (repartos y préstamos) y pagos.
  type Debt = { date: string; splitKey: string | null; amount: number };
  const debts = new Map<string, Debt[]>();
  const paid = new Map<string, number>();
  const key = (ref: string, c: Currency) => `${ref}|${c}`;
  for (const s of splits) {
    if (s.status !== "active" || s.ownerUid !== me) continue;
    for (const p of s.participants) {
      if (p.status !== "offline") continue;
      const k = key(p.ref, s.currency);
      debts.set(k, [...(debts.get(k) ?? []), { date: s.date, splitKey: `${s.id}|${p.ref}`, amount: p.amount }]);
    }
  }
  for (const t of transfers) {
    if (t.status !== "accepted") continue;
    const side = transferSide(t, me);
    if (!side || !side.person.startsWith("c:")) continue;
    const k = key(side.person, t.currency);
    if (side.direction === "out") debts.set(k, [...(debts.get(k) ?? []), { date: t.date, splitKey: null, amount: t.amount }]);
    else paid.set(k, round2((paid.get(k) ?? 0) + t.amount));
  }
  const recovered = new Map<string, number>();
  for (const [k, list] of debts) {
    let left = paid.get(k) ?? 0;
    for (const d of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
      if (left <= 0) break;
      const take = Math.min(left, d.amount);
      left = round2(left - take);
      if (d.splitKey) recovered.set(d.splitKey, round2((recovered.get(d.splitKey) ?? 0) + take));
    }
  }
  return recovered;
};

/**
 * Para cada gasto mío repartido: qué parte es mía.
 * - Usuarios de la app: su parte deja de ser mía cuando la ACEPTAN.
 * - Contactos sin app: cuando me la PAGAN (o toda, si `projected`: "si te pagan").
 */
export const buildSplitAdjustment = (
  me: string,
  splits: Split[],
  transfers: PersonTransfer[],
  opts: { projected?: boolean } = {},
): Map<string, SplitTxInfo> => {
  const recovered = opts.projected ? null : recoveredOfflineShares(me, splits, transfers);
  const byTx = new Map<string, SplitTxInfo>();
  for (const s of splits) {
    if (s.status !== "active" || s.ownerUid !== me) continue;
    let notMine = 0;
    const info: SplitTxInfo = {
      split: s,
      factor: 1,
      acceptedCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
      offlineCount: 0,
      othersCount: s.participants.length,
    };
    for (const p of s.participants) {
      if (p.status === "accepted") {
        info.acceptedCount += 1;
        notMine += p.amount;
      } else if (p.status === "pending") info.pendingCount += 1;
      else if (p.status === "rejected") info.rejectedCount += 1;
      else if (p.status === "offline") {
        info.offlineCount += 1;
        notMine += recovered ? (recovered.get(`${s.id}|${p.ref}`) ?? 0) : p.amount;
      }
    }
    info.factor = s.totalAmount > 0 ? Math.min(1, Math.max(0, (s.totalAmount - notMine) / s.totalAmount)) : 1;
    byTx.set(s.ownerTxId, info);
  }
  return byTx;
};
