import type { Currency } from "./types";

/**
 * Vaquitas: gastos compartidos de un grupo (una cena, un viaje entre
 * familias). Tipos y cálculos puros: los usan la web y el server.
 *
 * - Cada gasto lo pagan uno o varios integrantes y se divide entre algunos
 *   (en partes iguales por persona, por familia, o con montos).
 * - El saldo se calcula por "parte": una familia cuenta como una sola parte;
 *   quien no está en ninguna familia es una parte sola. Adentro de una
 *   familia no hay deudas.
 * - Todo se lleva a la moneda de la vaquita con la cotización del día del
 *   gasto (guardada en el gasto, así el saldo no cambia con el dólar).
 * - A los gastos de cada usuario de la app va lo que le toca a él
 *   (computeExpenseBooks): si pagó, su gasto con su cuenta (contando solo su
 *   parte); si no, "su parte" como gasto contra la vaquita.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.005;

// === Tipos (Firestore) ===

export interface VaquitaMember {
  /** Id estable dentro de la vaquita. */
  id: string;
  name: string;
  /** Usuario de la app (null = sin la app; lo cargan los demás). */
  uid: string | null;
  email: string | null;
  familyId: string | null;
}

export interface VaquitaFamily {
  id: string;
  name: string;
}

/** vaquitas/{id} — solo lo escribe el server. */
export interface Vaquita {
  id: string;
  name: string;
  /** Moneda en la que se muestran los saldos (la del viaje). */
  currency: Currency;
  createdByUid: string;
  members: VaquitaMember[];
  families: VaquitaFamily[];
  /** Usuarios de la app que participan (reglas y consultas). */
  uids: string[];
  /** Categoría de cada usuario para sus gastos de esta vaquita. */
  categoryByUid: Record<string, string>;
  status: "open" | "closed";
  /** Lo guarda el server en cada cambio (para la lista). */
  summary?: {
    total: number;
    /** Saldo de cada parte (id de familia o de integrante). + = le deben. */
    netByUnit: Record<string, number>;
    expenses: number;
    /** YYYY-MM-DD del último gasto. */
    lastDate: string | null;
  } | null;
  createdAt?: { toDate(): Date } | null;
  updatedAt?: { toDate(): Date } | null;
  closedAt?: { toDate(): Date } | null;
}

/** people: iguales entre personas · families: iguales entre partes · amounts: montos. */
export type VaquitaSplitMode = "people" | "families" | "amounts";

/** Con qué cuenta registró un usuario lo que pagó. */
export interface VaquitaLeg {
  accountId: string;
  installments: number;
}

/** vaquitas/{id}/expenses/{eid} — solo lo escribe el server. */
export interface VaquitaExpense {
  id: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  currency: Currency;
  /** Unidades de la moneda de la vaquita por 1 de `currency`. */
  rate: number;
  /** Quién pagó y cuánto (memberId → monto, en `currency`). */
  paidBy: Record<string, number>;
  splitMode: VaquitaSplitMode;
  /** Entre quiénes: memberIds (people/amounts) o ids de parte (families). */
  splitAmong: string[];
  /** Lo que le toca a cada integrante (memberId → monto, en `currency`). */
  shares: Record<string, number>;
  /**
   * Si pagó alguien de una familia: que la parte de la familia vaya a los
   * gastos de cada uno de sus integrantes (y no toda a los de quien pagó).
   */
  shareInFamily: boolean;
  /** uid → cuenta con la que pagó (solo quien pagó, y solo él la elige). */
  legs: Record<string, VaquitaLeg>;
  createdByUid: string;
  createdByName: string;
  createdAt?: { toDate(): Date } | null;
  updatedAt?: { toDate(): Date } | null;
}

/** vaquitas/{id}/payments/{pid}: plata que se pasaron para saldar. */
export interface VaquitaPayment {
  id: string;
  from: string;
  to: string;
  amount: number;
  currency: Currency;
  /** Unidades de la moneda de la vaquita por 1 de `currency`. */
  rate: number;
  /** YYYY-MM-DD */
  date: string;
  note: string;
  /** uid → cuenta de donde salió / a donde entró (cada uno la suya). */
  legs: Record<string, { accountId: string }>;
  createdByUid: string;
  createdAt?: { toDate(): Date } | null;
}

// === Partes (familias o personas sueltas) ===

export interface VaquitaUnit {
  /** Id de la familia, o el id del integrante si no está en ninguna. */
  id: string;
  name: string;
  isFamily: boolean;
  memberIds: string[];
}

export const vaquitaUnits = (v: Pick<Vaquita, "members" | "families">): VaquitaUnit[] => {
  const out: VaquitaUnit[] = [];
  for (const f of v.families) {
    const memberIds = v.members.filter((m) => m.familyId === f.id).map((m) => m.id);
    if (memberIds.length) out.push({ id: f.id, name: f.name, isFamily: true, memberIds });
  }
  for (const m of v.members) {
    if (m.familyId && v.families.some((f) => f.id === m.familyId)) continue;
    out.push({ id: m.id, name: m.name, isFamily: false, memberIds: [m.id] });
  }
  return out;
};

/** memberId → id de su parte. */
export const unitOfMember = (units: VaquitaUnit[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const u of units) for (const m of u.memberIds) map.set(m, u.id);
  return map;
};

/** Saldo de la parte de un usuario (su familia o él), según el resumen guardado. + = le deben. */
export const myUnitNet = (v: Pick<Vaquita, "members" | "families" | "summary">, uid: string | null | undefined) => {
  const me = v.members.find((m) => m.uid === uid);
  if (!me) return 0;
  const unit = unitOfMember(vaquitaUnits(v)).get(me.id);
  return unit ? (v.summary?.netByUnit?.[unit] ?? 0) : 0;
};

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

// === Dividir un gasto ===

/** Reparte `total` en `n` partes iguales (el resto del redondeo va a la última). */
export const equalParts = (total: number, n: number): number[] => {
  if (n <= 0) return [];
  const base = Math.floor((total / n) * 100) / 100;
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] = round2(total - base * (n - 1));
  return parts;
};

/**
 * Lo que le toca a cada integrante. En "families", cada parte elegida paga
 * igual y adentro se reparte igual entre sus integrantes (para el saldo da lo
 * mismo: cuenta la parte).
 */
export const computeShares = (
  v: Pick<Vaquita, "members" | "families">,
  input: { amount: number; splitMode: VaquitaSplitMode; splitAmong: string[]; amounts?: Record<string, number> },
): { shares: Record<string, number>; error: string | null } => {
  const shares: Record<string, number> = {};
  const memberIds = new Set(v.members.map((m) => m.id));
  if (!(input.amount > 0)) return { shares, error: "Ingresá un monto" };

  if (input.splitMode === "amounts") {
    let sum = 0;
    for (const [id, a] of Object.entries(input.amounts ?? {})) {
      if (!memberIds.has(id)) continue;
      const x = round2(a);
      if (x < 0) return { shares, error: "Los montos no pueden ser negativos" };
      if (x >= EPS) {
        shares[id] = x;
        sum += x;
      }
    }
    if (Object.keys(shares).length === 0) return { shares, error: "Poné cuánto le toca a cada uno" };
    if (Math.abs(round2(sum) - round2(input.amount)) >= 0.01) {
      return { shares, error: `Las partes suman ${round2(sum)} y el gasto es ${round2(input.amount)}` };
    }
    return { shares, error: null };
  }

  if (input.splitMode === "families") {
    const units = vaquitaUnits(v).filter((u) => input.splitAmong.includes(u.id));
    if (units.length === 0) return { shares, error: "Elegí entre quiénes se divide" };
    const perUnit = equalParts(input.amount, units.length);
    units.forEach((u, i) => {
      const inner = equalParts(perUnit[i], u.memberIds.length);
      u.memberIds.forEach((m, j) => {
        shares[m] = round2((shares[m] ?? 0) + inner[j]);
      });
    });
    return { shares, error: null };
  }

  const ids = input.splitAmong.filter((id) => memberIds.has(id));
  if (ids.length === 0) return { shares, error: "Elegí entre quiénes se divide" };
  const parts = equalParts(input.amount, ids.length);
  ids.forEach((id, i) => {
    shares[id] = parts[i];
  });
  return { shares, error: null };
};

/** Valida quién pagó: montos positivos que suman el total. */
export const checkPaidBy = (
  v: Pick<Vaquita, "members">,
  amount: number,
  paidBy: Record<string, number>,
): { paidBy: Record<string, number>; error: string | null } => {
  const out: Record<string, number> = {};
  const memberIds = new Set(v.members.map((m) => m.id));
  let sum = 0;
  for (const [id, a] of Object.entries(paidBy)) {
    if (!memberIds.has(id)) continue;
    const x = round2(a);
    if (x < 0) return { paidBy: out, error: "Lo pagado no puede ser negativo" };
    if (x >= EPS) {
      out[id] = x;
      sum += x;
    }
  }
  if (Object.keys(out).length === 0) return { paidBy: out, error: "Elegí quién pagó" };
  if (Math.abs(round2(sum) - round2(amount)) >= 0.01) {
    return { paidBy: out, error: `Lo que pagaron suma ${round2(sum)} y el gasto es ${round2(amount)}` };
  }
  return { paidBy: out, error: null };
};

// === Saldos ===

export interface UnitBalance extends VaquitaUnit {
  /** Todo en la moneda de la vaquita. */
  paid: number;
  share: number;
  /** Pagos para saldar: lo que mandó y lo que recibió. */
  sent: number;
  received: number;
  /** + = le deben; − = debe. */
  net: number;
}

export interface Settlement {
  fromUnit: string;
  toUnit: string;
  fromName: string;
  toName: string;
  /** En la moneda de la vaquita. */
  amount: number;
}

export interface VaquitaSummary {
  /** Total gastado, en la moneda de la vaquita. */
  total: number;
  units: UnitBalance[];
  /** Quién le paga a quién (la menor cantidad de pagos). */
  settlements: Settlement[];
  /** Lo que gastó cada integrante (su parte), en la moneda de la vaquita. */
  shareByMember: Record<string, number>;
}

export const toVaquitaCurrency = (amount: number, rate: number) => round2(amount * (rate > 0 ? rate : 1));

/**
 * Quién le paga a quién: el que más debe le paga al que más le deben, hasta
 * que no quede nada. Da a lo sumo (partes − 1) pagos.
 */
export const settleUp = (units: Array<Pick<UnitBalance, "id" | "name" | "net">>): Settlement[] => {
  const debtors = units.filter((u) => u.net < -EPS).map((u) => ({ ...u, left: -u.net }));
  const creditors = units.filter((u) => u.net > EPS).map((u) => ({ ...u, left: u.net }));
  debtors.sort((a, b) => b.left - a.left || a.name.localeCompare(b.name, "es"));
  creditors.sort((a, b) => b.left - a.left || a.name.localeCompare(b.name, "es"));
  const out: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const amount = round2(Math.min(d.left, c.left));
    if (amount >= 0.01) {
      out.push({ fromUnit: d.id, toUnit: c.id, fromName: d.name, toName: c.name, amount });
    }
    d.left = round2(d.left - amount);
    c.left = round2(c.left - amount);
    if (d.left < 0.01) i += 1;
    if (c.left < 0.01) j += 1;
  }
  return out;
};

export const summarizeVaquita = (
  v: Pick<Vaquita, "members" | "families">,
  expenses: VaquitaExpense[],
  payments: VaquitaPayment[],
): VaquitaSummary => {
  const units = vaquitaUnits(v);
  const unitOf = unitOfMember(units);
  const acc = new Map<string, { paid: number; share: number; sent: number; received: number }>();
  for (const u of units) acc.set(u.id, { paid: 0, share: 0, sent: 0, received: 0 });
  const shareByMember: Record<string, number> = {};
  let total = 0;

  for (const e of expenses) {
    total += toVaquitaCurrency(e.amount, e.rate);
    for (const [m, a] of Object.entries(e.paidBy ?? {})) {
      const u = acc.get(unitOf.get(m) ?? "");
      if (u) u.paid += toVaquitaCurrency(a, e.rate);
    }
    for (const [m, a] of Object.entries(e.shares ?? {})) {
      const x = toVaquitaCurrency(a, e.rate);
      shareByMember[m] = round2((shareByMember[m] ?? 0) + x);
      const u = acc.get(unitOf.get(m) ?? "");
      if (u) u.share += x;
    }
  }
  for (const p of payments) {
    const x = toVaquitaCurrency(p.amount, p.rate);
    const from = unitOf.get(p.from);
    const to = unitOf.get(p.to);
    // Adentro de una misma parte no cambia nada.
    if (!from || !to || from === to) continue;
    acc.get(from)!.sent += x;
    acc.get(to)!.received += x;
  }

  const balances: UnitBalance[] = units.map((u) => {
    const a = acc.get(u.id)!;
    return {
      ...u,
      paid: round2(a.paid),
      share: round2(a.share),
      sent: round2(a.sent),
      received: round2(a.received),
      net: round2(a.paid - a.share + a.sent - a.received),
    };
  });
  // El redondeo de pasar a la moneda de la vaquita puede dejar centavos
  // sueltos: se los queda la parte con el saldo más grande.
  const drift = round2(balances.reduce((s, b) => s + b.net, 0));
  if (Math.abs(drift) >= 0.01 && Math.abs(drift) < 1 && balances.length) {
    const big = [...balances].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))[0];
    big.net = round2(big.net - drift);
  }
  return { total: round2(total), units: balances, settlements: settleUp(balances), shareByMember };
};

// === A los gastos de quién va cada gasto ===

/**
 * Lo que le toca a cada usuario de la app de un gasto (en la moneda del
 * gasto), para sus cuentas:
 * - Persona sola: su parte.
 * - Familia donde pagó alguien con la app: toda la parte de la familia va a
 *   quien pagó (si pagaron varios, en proporción), salvo que `shareInFamily`
 *   la reparta entre los integrantes.
 * - Familia donde no pagó nadie con la app (o con `shareInFamily`): cada
 *   integrante con la app lleva su parte; las de quienes no usan la app se
 *   reparten entre los que sí (o van a quien pagó, si pagó alguien de ahí).
 * - Si en una parte no hay nadie con la app, no va a ningún lado.
 */
export const carriedShares = (
  v: Pick<Vaquita, "members" | "families">,
  e: Pick<VaquitaExpense, "paidBy" | "shares" | "shareInFamily">,
): Map<string, number> => {
  const byId = new Map(v.members.map((m) => [m.id, m]));
  const out = new Map<string, number>();
  const give = (uid: string, x: number) => out.set(uid, round2((out.get(uid) ?? 0) + x));
  // Reparte x entre uids con pesos (el resto del redondeo al último).
  const spread = (x: number, targets: Array<{ uid: string; w: number }>) => {
    const wsum = targets.reduce((s, t) => s + t.w, 0);
    if (!targets.length || !(wsum > 0) || Math.abs(x) < EPS) return;
    let used = 0;
    targets.forEach((t, i) => {
      const part = i === targets.length - 1 ? round2(x - used) : round2((x * t.w) / wsum);
      used = round2(used + part);
      give(t.uid, part);
    });
  };

  for (const u of vaquitaUnits(v)) {
    const members = u.memberIds.map((id) => byId.get(id)!).filter(Boolean);
    const unitShare = round2(members.reduce((s, m) => s + (e.shares?.[m.id] ?? 0), 0));
    if (unitShare < EPS) continue;
    const app = members.filter((m) => !!m.uid);
    if (app.length === 0) continue;
    if (!u.isFamily) {
      give(app[0].uid!, unitShare);
      continue;
    }
    const appPayers = app
      .filter((m) => (e.paidBy?.[m.id] ?? 0) >= EPS)
      .map((m) => ({ uid: m.uid!, w: e.paidBy[m.id] }));
    if (appPayers.length && !e.shareInFamily) {
      spread(unitShare, appPayers);
      continue;
    }
    // Cada uno con la app, lo suyo.
    let offline = 0;
    for (const m of members) {
      const s = e.shares?.[m.id] ?? 0;
      if (m.uid) give(m.uid, round2(s));
      else offline = round2(offline + s);
    }
    if (offline >= EPS) {
      spread(offline, appPayers.length ? appPayers : app.map((m) => ({ uid: m.uid!, w: 1 })));
    }
  }
  return out;
};

/** Lo que pagó cada usuario de la app (en la moneda del gasto). */
export const paidByUid = (
  v: Pick<Vaquita, "members">,
  e: Pick<VaquitaExpense, "paidBy">,
): Map<string, number> => {
  const out = new Map<string, number>();
  for (const m of v.members) {
    const a = e.paidBy?.[m.id] ?? 0;
    if (m.uid && a >= EPS) out.set(m.uid, round2((out.get(m.uid) ?? 0) + a));
  }
  return out;
};

export interface ExpenseBooksEntry {
  uid: string;
  /** Lo que le toca (en la moneda del gasto). */
  carried: number;
  /** Lo que pagó. */
  paid: number;
  /** Si registró con qué pagó: el gasto real (paid) y qué parte es suya. */
  realTx: { accountId: string; installments: number; amount: number; shareFactor: number } | null;
  /** Lo que le toca y no está en su gasto real: va como "su parte" contra la vaquita. */
  partAmount: number;
}

/** Qué escribir en las cuentas de cada usuario de la app por un gasto. */
export const computeExpenseBooks = (
  v: Pick<Vaquita, "members" | "families">,
  e: Pick<VaquitaExpense, "paidBy" | "shares" | "shareInFamily" | "legs">,
): ExpenseBooksEntry[] => {
  const carried = carriedShares(v, e);
  const paid = paidByUid(v, e);
  const uids = new Set([...carried.keys(), ...paid.keys()]);
  const out: ExpenseBooksEntry[] = [];
  for (const uid of uids) {
    const c = carried.get(uid) ?? 0;
    const p = paid.get(uid) ?? 0;
    const leg = e.legs?.[uid];
    let realTx: ExpenseBooksEntry["realTx"] = null;
    let partAmount = c;
    if (leg && p >= EPS) {
      const mine = Math.min(c, p);
      realTx = {
        accountId: leg.accountId,
        installments: Math.max(1, leg.installments || 1),
        amount: p,
        shareFactor: Math.round((mine / p) * 1e6) / 1e6,
      };
      partAmount = round2(c - mine);
    }
    out.push({ uid, carried: round2(c), paid: round2(p), realTx, partAmount: round2(partAmount) });
  }
  return out;
};

// === Cuentas virtuales ===

/** "Cuenta" de una vaquita en las cuentas de cada uno (no es una cuenta real). */
export const vaquitaAccountId = (vaquitaId: string) => `vaquita:${vaquitaId}`;
export const isVaquitaAccountId = (id: string | null | undefined): boolean => !!id?.startsWith("vaquita:");
export const vaquitaIdFromAccountId = (id: string | null | undefined): string | null =>
  id && id.startsWith("vaquita:") ? id.slice("vaquita:".length) : null;

/**
 * Unidades de `to` por 1 de `from`, con las cotizaciones en pesos (pesos por
 * unidad de cada moneda). null si falta alguna.
 */
export const crossRate = (
  from: Currency,
  to: Currency,
  arsRates: Partial<Record<Currency, number>> | null | undefined,
): number | null => {
  if (from === to) return 1;
  const r = (c: Currency) => (c === "ARS" ? 1 : (arsRates?.[c] ?? null));
  const a = r(from);
  const b = r(to);
  if (!a || !b) return null;
  return Math.round((a / b) * 1e6) / 1e6;
};
