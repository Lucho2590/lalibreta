import "server-only";

import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import { agendaReminders } from "./activities";
import { loadAccounts, loadCategories, toServerAccount, type ServerAccountInfo } from "./queries-admin";
import { getOrBuildCycle } from "./transactions-admin";
import { dateFromYMD, todayYMD } from "./time";
import { cardFloorMonth, summarizeCardMonth, TAX_CATEGORY } from "@/lib/domain/card-summary";
import { withDefaultPrefs, type NotificationPrefs } from "@/lib/domain/notifications";
import { CURRENCIES, type Currency, type Installment, type RecurringExpense } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";
import { computePeopleLedger } from "@/lib/domain/debts";
import { loadSplitsFor } from "./splits";
import { loadTransfersFor } from "./person-transfers";
import { weatherDailyReminders } from "./weather-alerts";

/**
 * Avisos del día (los corre el cron de Vercel una vez por día, a la mañana):
 * - vencimiento de tarjetas (N días antes, según las preferencias),
 * - cierre de tarjetas (opcional),
 * - fijos que tocan hoy y todavía no se cargaron,
 * - lo que hay en la agenda del día,
 * - cobrarle a la gente sin la app que te debe plata (cada N días),
 * - lo que te mandaron para responder y quedó colgado (gastos, transferencias, conexiones),
 * - el pronóstico del día (a quien activó la ubicación).
 * Cada aviso tiene una clave fija, así que correrlo dos veces no repite nada.
 */

const addDaysYMD = (ymd: string, days: number) =>
  todayYMD(new Date(dateFromYMD(ymd).getTime() + days * 86_400_000));

const ymdOf = (d: Date) => todayYMD(d);

const moneyText = (m: Record<Currency, number>) =>
  CURRENCIES.filter((c) => m[c] >= 0.01)
    .map((c) => formatMoney(m[c], c))
    .join(" + ");

const whenText = (days: number) =>
  days === 0 ? "Hoy" : days === 1 ? "Mañana" : `En ${days} días`;

export interface DailyRunResult {
  users: number;
  sent: number;
}

export const runDailyReminders = async (now = new Date()): Promise<DailyRunResult> => {
  const today = todayYMD(now);
  const users = await adminDb().collection("users").get();
  let sent = 0;
  const prefsByUid = new Map<string, NotificationPrefs>();
  for (const user of users.docs) {
    const prefs = withDefaultPrefs(user.data().notificationPrefs);
    prefsByUid.set(user.id, prefs);
    try {
      sent += await remindUser(user.id, prefs, today);
    } catch (err) {
      console.error("[cron] avisos de", user.id, err);
    }
  }
  try {
    sent += await agendaReminders(today, (uid) => prefsByUid.get(uid) ?? null);
  } catch (err) {
    console.error("[cron] agenda del día", err);
  }
  try {
    sent += await weatherDailyReminders(today, (uid) => prefsByUid.get(uid) ?? null);
  } catch (err) {
    console.error("[cron] clima del día", err);
  }
  return { users: users.size, sent };
};

export const remindUser = async (uid: string, prefs: NotificationPrefs, today: string): Promise<number> => {
  if (!prefs.cardDue && !prefs.cardClose && !prefs.recurring && !prefs.debts && !prefs.pendingReminders) return 0;
  let sent = 0;
  if (prefs.debts || prefs.pendingReminders) sent += await peopleReminders(uid, prefs, today);
  if (!prefs.cardDue && !prefs.cardClose && !prefs.recurring) return sent;
  const accounts = (await loadAccounts(uid)).filter((a) => a.active);
  const cards = accounts.filter((a) => a.type === "credit");

  if (prefs.cardDue && cards.length > 0) sent += await cardDueReminders(uid, cards, prefs.cardDueDaysBefore, today);
  if (prefs.cardClose && cards.length > 0) sent += await cardCloseReminders(uid, cards, today);
  if (prefs.recurring) sent += await recurringReminders(uid, accounts, today);
  return sent;
};

const cardDueReminders = async (
  uid: string,
  cards: ServerAccountInfo[],
  daysBefore: number,
  today: string,
): Promise<number> => {
  const target = addDaysYMD(today, daysBefore);
  const month = target.slice(0, 7);
  const taxIds = new Set(
    (await loadCategories(uid)).filter((c) => TAX_CATEGORY.test(c.name)).map((c) => c.id),
  );
  let sent = 0;
  for (const card of cards) {
    // Todos los movimientos de la tarjeta: un pago adelantado (hecho el mes
    // anterior) cuenta para este resumen y no hay que avisar.
    const cardSnap = await adminDb().collection(`users/${uid}/installments`).where("accountId", "==", card.id).get();
    const cardInstallments = cardSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as Installment);
    const s = summarizeCardMonth(cardInstallments, [card.id], month, taxIds, cardFloorMonth(card));
    if (!s.dueDate || ymdOf(s.dueDate) !== target) continue;
    if (s.pending.ARS < 0.01 && s.pending.USD < 0.01) continue;
    const amount = moneyText(s.pending);
    const r = await notify(uid, {
      kind: "card-due",
      title: `${whenText(daysBefore)} vence la ${card.name}`,
      body: `Te queda por pagar ${amount}.`,
      url: `/cuentas/${card.id}`,
      whatsappText: `💳 ${whenText(daysBefore)} vence la *${card.name}*: te queda por pagar *${amount}*.`,
      dedupeKey: `card-due-${card.id}-${month}`,
    });
    if (r.stored) sent += 1;
  }
  return sent;
};

const cardCloseReminders = async (uid: string, cards: ServerAccountInfo[], today: string): Promise<number> => {
  const [y, m] = today.split("-").map(Number);
  let sent = 0;
  for (const card of cards) {
    if (!card.defaultClosingDay) continue;
    const cycle = await getOrBuildCycle(uid, toServerAccount(card), y, m);
    if (ymdOf(cycle.closingDate.toDate()) !== today) continue;
    const r = await notify(uid, {
      kind: "card-close",
      title: `Hoy cierra la ${card.name}`,
      body: "Lo que compres desde mañana entra en el próximo resumen.",
      url: `/cuentas/${card.id}`,
      dedupeKey: `card-close-${card.id}-${today.slice(0, 7)}`,
    });
    if (r.stored) sent += 1;
  }
  return sent;
};

const recurringReminders = async (uid: string, accounts: ServerAccountInfo[], today: string): Promise<number> => {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const snap = await adminDb().collection(`users/${uid}/recurring`).where("active", "==", true).get();
  let sent = 0;
  for (const doc of snap.docs) {
    const rec = { id: doc.id, ...doc.data() } as RecurringExpense;
    // Un fijo del 31 en un mes de 30 días toca el último día.
    if (Math.min(rec.dayOfMonth, lastDay) !== day) continue;
    if (month < rec.startMonth || (rec.endMonth && month > rec.endMonth)) continue;
    const applied = await adminDb()
      .collection(`users/${uid}/installments`)
      .where("recurringId", "==", rec.id)
      .where("billingMonth", "==", month)
      .limit(1)
      .get();
    if (!applied.empty) continue;
    const account = accounts.find((a) => a.id === rec.accountId);
    const amount = formatMoney(rec.amount, rec.currency ?? "ARS");
    const what = rec.kind === "income" ? "cobrás" : "pagás";
    const r = await notify(uid, {
      kind: "recurring-due",
      title: `Hoy ${what} ${rec.name}`,
      body: `${amount}${account ? ` · ${account.name}` : ""}. Cargalo desde Fijos con un toque.`,
      url: "/fijos",
      whatsappText: `🔁 Hoy ${what} *${rec.name}* (${amount}). Si querés, pedime que lo cargue.`,
      dedupeKey: `recurring-${rec.id}-${month}`,
    });
    if (r.stored) sent += 1;
  }
  return sent;
};

// === Cuentas con gente ===

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((dateFromYMD(b).getTime() - dateFromYMD(a).getTime()) / DAY_MS);
const ymdOfTs = (ts: unknown) => {
  const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
  return d ? todayYMD(d) : null;
};

/**
 * - Gente sin la app que me debe (vencido, hace 3+ días): un aviso agrupado
 *   cada `debtsEveryDays` días.
 * - Cosas que me mandaron y no respondí en 2+ días: un aviso por semana.
 */
const peopleReminders = async (uid: string, prefs: NotificationPrefs, today: string): Promise<number> => {
  const [splits, transfers] = await Promise.all([loadSplitsFor(uid), loadTransfersFor(uid)]);
  let sent = 0;
  const dayIndex = Math.floor(dateFromYMD(today).getTime() / DAY_MS);

  if (prefs.debts) {
    const ledger = computePeopleLedger({ me: uid, splits, transfers, nowMonth: today.slice(0, 7) });
    const owing = [...ledger.values()].filter(
      (l) =>
        !l.isApp &&
        CURRENCIES.some((c) => l.due[c] >= 0.01) &&
        // Lo más viejo que debe tiene al menos 3 días.
        l.entries.some((e) => e.amount > 0 && !e.future && daysBetween(e.date, today) >= 3),
    );
    if (owing.length > 0) {
      const every = Math.max(1, prefs.debtsEveryDays || 7);
      const list = owing.map((l) => `${l.name} te debe ${moneyText(l.due)}`);
      const first = owing[0];
      const firstCur = CURRENCIES.find((c) => first.due[c] >= 0.01) ?? "ARS";
      const r = await notify(uid, {
        kind: "debt-reminder",
        title: owing.length === 1 ? `Acordate de cobrarle a ${first.name}` : "Gente que te debe plata",
        body: `${list.join(" · ")}.`,
        url: "/compartidas",
        whatsappText: `💸 Para cobrar: ${list.join(" · ")}. ¿Ya te pagó? Decime, por ejemplo, "${first.name.split(" ")[0]} me pagó ${formatMoney(first.due[firstCur], firstCur)} a MP".`,
        dedupeKey: `debts-${Math.floor(dayIndex / every)}`,
      });
      if (r.stored) sent += 1;
    }
  }

  if (prefs.pendingReminders) {
    const week = Math.floor(dayIndex / 7);
    const old = (ts: unknown) => {
      const d = ymdOfTs(ts);
      return !!d && daysBetween(d, today) >= 2;
    };
    const items: Array<{ id: string; text: string }> = [];
    for (const s of splits) {
      const me = s.participants.find((p) => p.uid === uid);
      if (s.status === "active" && s.ownerUid !== uid && me?.status === "pending" && old(s.updatedAt ?? s.createdAt)) {
        items.push({ id: `split-${s.id}`, text: `${s.ownerName}: ${s.description} (${formatMoney(me.amount, s.currency)})` });
      }
    }
    for (const t of transfers) {
      if (t.status === "pending" && t.createdByUid !== uid && old(t.createdAt)) {
        items.push({ id: `p2p-${t.id}`, text: `${t.description} (${formatMoney(t.amount, t.currency)})` });
      }
    }
    const conns = await adminDb().collection("connections").where("uids", "array-contains", uid).get();
    for (const c of conns.docs) {
      const d = c.data();
      if (d.status === "pending" && d.addresseeUid === uid && old(d.createdAt)) {
        const p = d.profiles?.[d.requesterUid];
        items.push({ id: `conn-${c.id}`, text: `${p?.displayName || p?.email || "Alguien"} quiere conectarse` });
      }
    }
    if (items.length > 0) {
      const r = await notify(uid, {
        kind: "pending-reminder",
        title: items.length === 1 ? "Tenés algo para responder" : `Tenés ${items.length} cosas para responder`,
        body: items.map((i) => i.text).join(" · "),
        url: "/compartidas",
        dedupeKey: `pending-${week}-${items.map((i) => i.id).sort().join("_").slice(0, 300)}`,
      });
      if (r.stored) sent += 1;
    }
  }
  return sent;
};
