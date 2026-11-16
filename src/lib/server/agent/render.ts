import "server-only";

import { formatCurrency, formatMoney } from "@/lib/format";
import { dateFromYMD, formatShortDateAR } from "../time";
import type { ReplyButton } from "../whatsapp/client";
import {
  draftType,
  type AccountDraft,
  type BatchDraft,
  type CardPaymentDraft,
  type Draft,
  type ExchangeDraft,
  type RecurringDraft,
  type TransferDraft,
  type PersonTransferDraft,
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
  if (d.split?.people.length) {
    const cur = d.currency ?? "ARS";
    const others = d.split.people.reduce((s, p) => s + p.amount, 0);
    const inCuotas = d.installments > 1 ? (d.split.mode === "lump" ? " (todo junto)" : " (en cuotas)") : "";
    lines.push("", "👥 *Dividido*");
    for (const p of d.split.people) {
      lines.push(
        `• ${p.name}: ${formatMoney(p.amount, cur)}${inCuotas} — ${p.isApp ? "le llega para aceptar" : p.newName ? "sin app (lo agrego), te lo debe" : "sin app, te lo debe"}`,
      );
    }
    lines.push(`• Vos: ${formatMoney(Math.round((d.amount - others) * 100) / 100, cur)}`);
  }
  lines.push("", "¿Lo guardo?");
  return lines.join("\n");
};

const renderPersonTransfer = (d: PersonTransferDraft) =>
  [
    d.direction === "in" ? "💸 *Te pasaron plata*" : d.kind === "loan" ? "💸 *Préstamo*" : "💸 *Le pasaste plata*",
    "",
    d.direction === "in"
      ? `*${d.personName}* te pasó *${formatMoney(d.amount, d.currency)}*`
      : `${d.kind === "loan" ? "Le prestás" : "Le pasás"} a *${d.personName}* *${formatMoney(d.amount, d.currency)}*`,
    `${d.direction === "in" ? "Entró en" : "Sale de"}: ${d.accountName}`,
    `Fecha: ${fecha(d.date)}`,
    "",
    d.isApp
      ? `_No es ingreso ni gasto: salda lo que se deben. ${d.personName.split(" ")[0]} lo tiene que confirmar._`
      : `_No es ingreso ni gasto: salda lo que se deben.${d.newName ? ` Agrego a ${d.personName} como contacto sin app.` : ""}_`,
    "",
    "¿Lo registro?",
  ].join("\n");

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

  // Consumos: compras, cuotas, suscripciones y reintegros (todo menos pagos y cargos).
  const consumos = d.lines.filter((l) => l.type !== "payment" && !CHARGE_TYPES.has(l.type));
  if (consumos.length > 0) {
    const sum = (c: "ARS" | "USD") =>
      Math.round(consumos.filter((l) => l.currency === c).reduce((a, l) => a + l.amount, 0) * 100) / 100;
    const parts = [sum("ARS") ? money(sum("ARS")) : null, sum("USD") ? usd(sum("USD")) : null].filter(Boolean);
    const cuotas = consumos.filter((l) => l.installment).length;
    out.push(
      "",
      `🛒 *${consumos.length} ${consumos.length === 1 ? "consumo" : "consumos"}*${parts.length ? `: ${parts.join(" + ")}` : ""}${cuotas ? ` (${cuotas} en cuotas)` : ""}`,
    );
  }

  const charges = d.lines.filter((l) => CHARGE_TYPES.has(l.type));
  if (charges.length > 0) {
    const ars = charges.filter((l) => l.currency === "ARS").reduce((a, l) => a + l.amount, 0);
    const usdSum = charges.filter((l) => l.currency === "USD").reduce((a, l) => a + l.amount, 0);
    const parts = [ars ? money(Math.round(ars * 100) / 100) : null, usdSum ? usd(Math.round(usdSum * 100) / 100) : null].filter(Boolean);
    out.push(`🏛️ *Impuestos y cargos*${parts.length ? `: ${parts.join(" + ")}` : ""}`);
    for (const c of charges.slice(0, 8)) {
      out.push(`• ${c.description}: ${c.currency === "USD" ? usd(c.amount) : money(c.amount)}`);
    }
    if (charges.length > 8) out.push(`• … y ${charges.length - 8} más`);
  }

  if (d.subscriptions.length > 0) {
    out.push("", "🔁 *Suscripciones para dar de alta como fijo:*");
    for (const s of d.subscriptions) {
      out.push(`• ${s.name}: ${s.currency === "USD" ? usd(s.amount) : money(s.amount)} (día ${s.dayOfMonth})`);
    }
  }

  out.push(
    "",
    "*Guardar todo*: guarda el resumen y las fechas, y carga cada consumo, cuota, impuesto y reintegro en la tarjeta (lo que ya tengas cargado no se repite), más los fijos.",
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
    ...(d.exchangeDiff && d.quotedRate
      ? [
          `Pactado a ${formatMoney(d.quotedRate, "ARS")}: diferencia de *${d.exchangeDiff > 0 ? "+" : "−"}${formatMoney(Math.abs(d.exchangeDiff), "ARS")}* ${d.exchangeDiff > 0 ? "a favor" : "en contra"} _(queda registrada)_`,
        ]
      : []),
    ...(d.withWhom ? [`Con: ${d.withWhom}`] : []),
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
    ...(d.addCurrencyToDestination
      ? [`_${d.toAccountName} no tenía ${d.currency === "USD" ? "dólares" : "pesos"}: se los agrego._`]
      : []),
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

const BATCH_SHOWN = 20;

const renderBatch = (d: BatchDraft) => {
  const n = d.lines.length;
  const incomes = d.lines.filter((l) => l.kind === "income").length;
  const accounts = [...new Set(d.lines.map((l) => l.accountName))];
  const out = [
    `🧾 *${n} ${incomes === n ? (n === 1 ? "ingreso" : "ingresos") : n === 1 ? "movimiento" : "movimientos"} para cargar*`,
    accounts.length === 1 ? `Cuenta: ${accounts[0]}` : `Cuentas: ${accounts.join(", ")}`,
    "",
  ];
  const several = accounts.length > 1;
  for (const l of d.lines.slice(0, BATCH_SHOWN)) {
    const cuota = l.installmentNumber && l.installmentsTotal ? ` (cuota ${l.installmentNumber}/${l.installmentsTotal})` : "";
    const sign = l.kind === "income" ? "+" : "";
    out.push(
      `• ${fecha(l.date)} ${l.description}: ${sign}${formatMoney(l.amount, l.currency)}${cuota} · _${l.categoryName}_${several ? ` · ${l.accountName}` : ""}`,
    );
  }
  if (n > BATCH_SHOWN) out.push(`• … y ${n - BATCH_SHOWN} más`);

  const total = (c: "ARS" | "USD") =>
    Math.round(d.lines.filter((l) => l.currency === c).reduce((a, l) => a + (l.kind === "income" ? -l.amount : l.amount), 0) * 100) / 100;
  const parts = [total("ARS") ? formatMoney(total("ARS"), "ARS") : null, total("USD") ? formatMoney(total("USD"), "USD") : null].filter(Boolean);
  out.push("", `Total: *${parts.join(" + ") || formatMoney(0, "ARS")}*`);

  const byCat = new Map<string, number>();
  for (const l of d.lines) byCat.set(l.categoryName, (byCat.get(l.categoryName) ?? 0) + 1);
  if (byCat.size > 1) {
    out.push(`Categorías: ${[...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c} (${k})`).join(", ")}`);
  }
  if (d.lines.some((l) => l.installmentsTotal)) {
    out.push("_Las cuotas se cargan con la compra completa, así las que faltan quedan en los próximos resúmenes._");
  }
  if (d.duplicates.length > 0) {
    out.push(`_Ya tenías cargados ${d.duplicates.length}: no los repito._`);
  }
  if (d.skipped.length > 0) out.push(`⚠️ No puedo cargar: ${d.skipped.join("; ")}`);
  out.push("", "Si querés cambiar una categoría o sacar alguno, decímelo. ¿Los cargo?");
  return out.join("\n");
};

export const renderDraft = (d: Draft): string => {
  switch (draftType(d)) {
    case "batch":
      return renderBatch(d as BatchDraft);
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
    case "person-transfer":
      return renderPersonTransfer(d as PersonTransferDraft);
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
  if (draftType(d) === "batch") {
    return [
      { id: `confirm:${d.id}`, title: "✅ Cargar todo" },
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
  if (draftType(d) === "batch") {
    const b = d as BatchDraft;
    return JSON.stringify({
      type: "batch",
      lines: b.lines.map((l) => ({
        description: l.description,
        amount: l.amount,
        currency: l.currency,
        kind: l.kind,
        date: l.date,
        accountId: l.accountId,
        categoryId: l.categoryId,
        categoryName: l.categoryName,
        ...(l.installmentsTotal ? { installmentNumber: l.installmentNumber, installmentsTotal: l.installmentsTotal } : {}),
      })),
      alreadyLoaded: b.duplicates.length,
    });
  }
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
