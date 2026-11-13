import "server-only";

import { formatCurrency, formatMoney } from "@/lib/format";
import { dateFromYMD, formatShortDateAR } from "../time";
import type { ReplyButton } from "../whatsapp/client";
import {
  draftType,
  type AccountDraft,
  type CardPaymentDraft,
  type Draft,
  type ExchangeDraft,
  type RecurringDraft,
  type TransferDraft,
  type StatementDraft,
  type TransactionDraft,
} from "../whatsapp/types";

const money = (n: number) => formatCurrency(n);
const usd = (n: number) =>
  `US$ ${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n)}`;
const fecha = (ymd: string) => formatShortDateAR(dateFromYMD(ymd));

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  cash: "Efectivo",
  debit: "Tarjeta de débito",
  credit: "Tarjeta de crédito",
  checking: "Cuenta corriente",
  savings: "Caja de ahorro",
  digital: "Billetera digital",
  reserve: "Cobacha",
};

const renderTransaction = (d: TransactionDraft) => {
  const lines = [
    d.kind === "income" ? "💰 *Nuevo ingreso*" : "🧾 *Nuevo gasto*",
    "",
    `*${d.description}*`,
    `Monto: *${formatMoney(d.amount, d.currency ?? "ARS")}*`,
  ];
  if (d.installments > 1) {
    lines.push(
      `Cuotas: ${d.installments} de ${formatMoney(Math.round((d.amount / d.installments) * 100) / 100, d.currency ?? "ARS")}`,
    );
  }
  lines.push(`Cuenta: ${d.accountName}`);
  lines.push(`Categoría: ${d.categoryName}${d.newCategory ? " _(nueva, se crea al guardar)_" : ""}`);
  lines.push(`Fecha: ${fecha(d.date)}`);
  if (d.cardClosedAtPurchase) lines.push("La tarjeta ya había cerrado: pasa al resumen siguiente");
  if (d.cardDatesPending) {
    lines.push("", `📅 La ${d.accountName} todavía no tiene fechas de cierre: cuando me las pases (o el resumen), acomodo este gasto en el resumen que corresponde.`);
  }
  lines.push("", "¿Lo guardo?");
  return lines.join("\n");
};

const accountLine = (a: AccountDraft["accounts"][number]) => {
  let line = `• *${a.name}* — ${ACCOUNT_TYPE_LABEL[a.accountType]}`;
  if (a.accountType === "credit") {
    line += a.closingDay ? ` · cierra el ${a.closingDay} · vence el ${a.dueDay}` : " · _fechas pendientes_";
    if (a.last4) line += ` · ···· ${a.last4}`;
    if (a.parentName) line += ` · de ${a.parentName}`;
  } else {
    const cs = a.currencies ?? ["ARS"];
    if (a.accountType === "reserve" && a.parentName) line += ` · dentro de ${a.parentName}`;
    line += ` · ${cs.map((c) => (c === "USD" ? "US$" : "$")).join(" y ")}`;
    if (a.isMain) line += " · ⭐ principal";
    const ob = a.openingBalances;
    if (ob && (ob.ARS || ob.USD)) {
      const parts = [ob.ARS ? formatMoney(ob.ARS, "ARS") : null, ob.USD ? formatMoney(ob.USD, "USD") : null].filter(Boolean);
      line += `\n   saldo inicial: ${parts.join(" + ")}`;
    }
  }
  return line;
};

export const pendingDatesText = (names: string[]) => {
  if (names.length === 0) return "";
  const list = names.map((n) => `*${n}*`).join(names.length === 2 ? " y " : ", ");
  return `📅 ${names.length === 1 ? "A" : "A las tarjetas"} ${list} le${names.length === 1 ? "" : "s"} faltan el día de cierre y de vencimiento. Podés cargar gastos igual; cuando puedas, pasámelos (ej. "la visa cierra el 25 y vence el 7") o mandame el *último resumen* (PDF o foto) y los saco de ahí, y acomodo lo que hayas cargado 😉`;
};

const renderAccount = (d: AccountDraft) => {
  const n = d.accounts.length;
  const lines = [n === 1 ? "🏦 *Nueva cuenta*" : `🏦 *${n} cuentas nuevas*`, "", ...d.accounts.map(accountLine)];
  if (d.alreadyExisting.length > 0) {
    lines.push("", `(Ya tenías: ${d.alreadyExisting.join(", ")})`);
  }
  const pending = d.accounts.filter((a) => a.accountType === "credit" && !a.closingDay).map((a) => a.name);
  if (pending.length > 0) lines.push("", pendingDatesText(pending));
  lines.push("", n === 1 ? "¿La creo?" : "¿Las creo?");
  return lines.join("\n");
};

const CHARGE_TYPES = new Set(["tax", "fee", "interest"]);

const renderStatement = (d: StatementDraft) => {
  const out = [
    "💳 *Resumen de tarjeta*",
    "",
    `*${d.accountName}*${d.last4 ? ` ···· ${d.last4}` : ""}${d.newCard ? " _(tarjeta nueva, se crea al guardar)_" : ""}`,
    `Cierre: ${fecha(d.closingDate)} · Vence: ${fecha(d.dueDate)}`,
  ];
  if (d.nextClosingDate && d.nextDueDate) {
    out.push(`Próximo: cierra ${fecha(d.nextClosingDate)} · vence ${fecha(d.nextDueDate)}`);
  }
  out.push(`Total: *${money(d.totalARS)}*${d.totalUSD ? ` + ${usd(d.totalUSD)}` : ""}`);
  if (d.minimumPayment) out.push(`Pago mínimo: ${money(d.minimumPayment)}`);

  const charges = d.lines.filter((l) => l.currency === "ARS" && CHARGE_TYPES.has(l.type));
  if (d.chargesARS > 0) {
    out.push("", `🏛️ *Impuestos y cargos: ${money(d.chargesARS)}*`);
    for (const c of charges.slice(0, 8)) out.push(`• ${c.description}: ${money(c.amount)}`);
    if (charges.length > 8) out.push(`• … y ${charges.length - 8} más`);
    out.push(`→ se cargan como gasto en _${d.chargesCategoryName}_`);
  }
  if (d.chargesUSD) {
    out.push(`🏛️ *Impuestos y cargos en dólares: ${usd(d.chargesUSD)}* → se cargan como gasto en US$`);
  }

  if (d.subscriptions.length > 0) {
    out.push("", "🔁 *Suscripciones para dar de alta como fijo:*");
    for (const s of d.subscriptions) {
      out.push(`• ${s.name}: ${s.currency === "USD" ? usd(s.amount) : money(s.amount)} (día ${s.dayOfMonth})`);
    }
  }

  out.push(
    "",
    "*Guardar todo*: guarda el resumen y las fechas, carga los impuestos/cargos y los fijos.",
    "*Solo resumen*: guarda el resumen y las fechas, sin crear movimientos.",
  );
  return out.join("\n");
};

const fmtDate = (ymd: string) => fecha(ymd);

const renderExchange = (d: ExchangeDraft) => {
  const selling = d.fromCurrency === "USD";
  const lines = [
    selling ? "💱 *Venta de dólares*" : "💱 *Compra de dólares*",
    "",
    `${selling ? "Vendés" : "Comprás"} *${formatMoney(selling ? d.fromAmount : d.toAmount, "USD")}*`,
    `${selling ? "Recibís" : "Pagás"} *${formatMoney(selling ? d.toAmount : d.fromAmount, "ARS")}*`,
    `Cotización: ${formatMoney(d.rate, "ARS")}${d.rateSource === "BCRA" ? ` _(oficial BCRA del ${fmtDate(d.rateDate ?? d.date)}; si cambiaste a otro valor, decímelo)_` : ""}`,
    d.fromAccountId === d.toAccountId
      ? `Cuenta: ${d.fromAccountName}`
      : `De: ${d.fromAccountName} → A: ${d.toAccountName}`,
    `Fecha: ${fmtDate(d.date)}`,
  ];
  if (d.after.length > 0) {
    lines.push("", "Te quedaría:");
    for (const a of d.after) lines.push(`• ${a.accountName}: ${formatMoney(a.amount, a.currency)}`);
  }
  lines.push("", "¿Lo registro?");
  return lines.join("\n");
};

const renderCardPayment = (d: CardPaymentDraft) => {
  const lines = ["💳 *Pago de tarjeta*", "", `*${d.cardName}*`];
  for (const p of d.payments) {
    lines.push(
      p.payWith === p.currency
        ? `• ${formatMoney(p.amount, p.currency)}`
        : `• ${formatMoney(p.amount, p.currency)} pagados con ${formatMoney(p.payAmount, p.payWith)} (a ${formatMoney(p.rate ?? 0, "ARS")})`,
    );
  }
  lines.push(`Desde: ${d.fromAccountName}`);
  lines.push(`Fecha: ${fmtDate(d.date)}`);
  if (d.amountSource === "statement") lines.push("_(monto del último resumen; si pagaste otro, decímelo)_");
  if (d.amountSource === "app") lines.push("_(lo que la app tiene a pagar; si pagaste otro monto, decímelo)_");
  lines.push("", "¿Lo registro?");
  return lines.join("\n");
};

const renderTransfer = (d: TransferDraft) => {
  const toReserve = d.description.startsWith("Guardado");
  const fromReserve = d.description.startsWith("Retiro");
  const lines = [
    toReserve ? "🫙 *Guardar en cobacha*" : fromReserve ? "🫙 *Sacar de cobacha*" : "🔀 *Transferencia*",
    "",
    `*${formatMoney(d.amount, d.currency)}*`,
    `De: ${d.fromAccountName} → A: ${d.toAccountName}`,
    `Fecha: ${fmtDate(d.date)}`,
    "",
    "Te quedaría:",
    ...d.after.map((a) => `• ${a.accountName}: ${formatMoney(a.amount, a.currency)}`),
    "",
    "¿Lo registro?",
  ];
  return lines.join("\n");
};

const renderRecurring = (d: RecurringDraft) =>
  [
    d.kind === "income" ? "🔁 *Nuevo ingreso fijo*" : "🔁 *Nuevo gasto fijo*",
    "",
    `*${d.name}*: ${formatMoney(d.amount, d.currency)} todos los ${d.dayOfMonth}`,
    `Cuenta: ${d.accountName}`,
    `Categoría: ${d.categoryName}`,
    "",
    "¿Lo guardo?",
  ].join("\n");

export const renderDraft = (d: Draft): string => {
  switch (draftType(d)) {
    case "account":
      return renderAccount(d as AccountDraft);
    case "statement":
      return renderStatement(d as StatementDraft);
    case "exchange":
      return renderExchange(d as ExchangeDraft);
    case "card-payment":
      return renderCardPayment(d as CardPaymentDraft);
    case "recurring":
      return renderRecurring(d as RecurringDraft);
    case "transfer":
      return renderTransfer(d as TransferDraft);
    default:
      return renderTransaction(d as TransactionDraft);
  }
};

export const draftButtons = (d: Draft): ReplyButton[] => {
  if (draftType(d) === "statement") {
    return [
      { id: `confirm:${d.id}`, title: "✅ Guardar todo" },
      { id: `summary:${d.id}`, title: "📄 Solo resumen" },
      { id: `cancel:${d.id}`, title: "❌ Cancelar" },
    ];
  }
  return [
    { id: `confirm:${d.id}`, title: "✅ Confirmar" },
    { id: `cancel:${d.id}`, title: "❌ Cancelar" },
  ];
};

/** Versión corta del borrador para el system prompt (los resúmenes pueden ser enormes). */
export const draftForPrompt = (d: Draft): string => {
  if (draftType(d) !== "statement") return JSON.stringify(d);
  const s = d as StatementDraft;
  return JSON.stringify({
    type: "statement",
    accountId: s.accountId,
    accountName: s.accountName,
    newCard: s.newCard,
    period: s.period,
    closingDate: s.closingDate,
    dueDate: s.dueDate,
    totalARS: s.totalARS,
    chargesARS: s.chargesARS,
    chargesCategoryName: s.chargesCategoryName,
    subscriptions: s.subscriptions.map((x) => x.name),
    lines: s.lines.length,
  });
};
