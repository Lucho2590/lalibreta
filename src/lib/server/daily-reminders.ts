import "server-only";

import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import { loadAccounts, loadCategories, toServerAccount, type ServerAccountInfo } from "./queries-admin";
import { getOrBuildCycle } from "./transactions-admin";
import { dateFromYMD, todayYMD } from "./time";
import { summarizeCardMonth, TAX_CATEGORY } from "@/lib/domain/card-summary";
import { withDefaultPrefs, type NotificationPrefs } from "@/lib/domain/notifications";
import type { Currency, Installment, RecurringExpense } from "@/lib/domain/types";
import { formatMoney } from "@/lib/format";

/**
 * Avisos del día (los corre el cron de Vercel una vez por día, a la mañana):
 * - vencimiento de tarjetas (N días antes, según las preferencias),
 * - cierre de tarjetas (opcional),
 * - fijos que tocan hoy y todavía no se cargaron.
 * Cada aviso tiene una clave fija, así que correrlo dos veces no repite nada.
 */

const addDaysYMD = (ymd: string, days: number) =>
  todayYMD(new Date(dateFromYMD(ymd).getTime() + days * 86_400_000));

const ymdOf = (d: Date) => todayYMD(d);

const moneyText = (m: Record<Currency, number>) =>
  (["ARS", "USD"] as const)
    .filter((c) => m[c] >= 0.01)
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
  for (const user of users.docs) {
    const prefs = withDefaultPrefs(user.data().notificationPrefs);
    try {
      sent += await remindUser(user.id, prefs, today);
    } catch (err) {
      console.error("[cron] avisos de", user.id, err);
    }
  }
  return { users: users.size, sent };
};

export const remindUser = async (uid: string, prefs: NotificationPrefs, today: string): Promise<number> => {
  if (!prefs.cardDue && !prefs.cardClose && !prefs.recurring) return 0;
  const accounts = (await loadAccounts(uid)).filter((a) => a.active);
  const cards = accounts.filter((a) => a.type === "credit");
  let sent = 0;

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
  const snap = await adminDb().collection(`users/${uid}/installments`).where("paymentMonth", "==", month).get();
  const installments = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as Installment);
  const taxIds = new Set(
    (await loadCategories(uid)).filter((c) => TAX_CATEGORY.test(c.name)).map((c) => c.id),
  );
  let sent = 0;
  for (const card of cards) {
    const s = summarizeCardMonth(installments, [card.id], month, taxIds);
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
