import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { DOCUMENT_MODEL, openai } from "./agent/openai";
import { createAccountAdmin } from "./accounts-admin";
import { createTransactionAdmin } from "./transactions-admin";
import { saveStatementAdmin } from "./statements-admin";
import { loadAccounts, loadCategories, toServerAccount } from "./queries-admin";
import { dateFromYMD, isYMD } from "./time";
import { normalizeMerchant } from "@/lib/domain/merchants";
import {
  isCreditLine,
  isPaymentLine,
  type AnalyzedLine,
  type ImportPayload,
  type ImportResult,
  type StatementAnalysis,
} from "@/lib/domain/statement-import";
import type { Currency, StatementLineType } from "@/lib/domain/types";
import type { StatementDraft } from "./whatsapp/types";

/**
 * Importar un resumen de tarjeta desde la web:
 * - analyzeStatement: lee el PDF/imagen con IA, elige la tarjeta, sugiere
 *   categorías (primero las reglas aprendidas del usuario) y marca lo que ya
 *   estaba cargado. No guarda nada.
 * - importStatement: guarda el resumen y fechas, carga los consumos elegidos
 *   como gastos (las cuotas, con la compra completa) y aprende las categorías
 *   (users/{uid}/categoryRules/{comercio}).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const LINE_TYPES: StatementLineType[] = [
  "purchase", "installment", "subscription", "tax", "fee", "interest", "payment", "credit", "other",
];

// === Reglas aprendidas ===

export interface CategoryRule {
  key: string;
  categoryId: string;
  sample: string;
  count: number;
}

export const loadCategoryRules = async (uid: string): Promise<CategoryRule[]> => {
  const snap = await adminDb().collection(`users/${uid}/categoryRules`).get();
  return snap.docs.map((d) => ({
    key: d.id,
    categoryId: String(d.data().categoryId ?? ""),
    sample: String(d.data().sample ?? d.id),
    count: Number(d.data().count ?? 1),
  }));
};

// === Análisis ===

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "cardLast4", "cardBrand", "cardBank", "suggestedCardName", "matchedAccountId",
    "closingDate", "dueDate", "nextClosingDate", "nextDueDate", "totalARS", "totalUSD",
    "minimumPayment", "lines",
  ],
  properties: {
    cardLast4: { type: ["string", "null"], description: "Últimos 4 dígitos de la tarjeta" },
    cardBrand: { type: ["string", "null"], description: "Visa, Mastercard, Amex…" },
    cardBank: { type: ["string", "null"], description: "Banco o emisor" },
    suggestedCardName: { type: "string", description: 'Nombre corto para la tarjeta, ej. "Visa Galicia"' },
    matchedAccountId: {
      type: ["string", "null"],
      description: "id de la tarjeta del usuario a la que corresponde el resumen, o null si no está",
    },
    closingDate: { type: "string", description: "Cierre de este resumen, YYYY-MM-DD" },
    dueDate: { type: "string", description: "Vencimiento de este resumen, YYYY-MM-DD" },
    nextClosingDate: { type: ["string", "null"] },
    nextDueDate: { type: ["string", "null"] },
    totalARS: { type: "number" },
    totalUSD: { type: "number" },
    minimumPayment: { type: ["number", "null"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "date", "rawDescription", "description", "amount", "currency", "installmentNumber",
          "installmentsTotal", "type", "categoryId",
        ],
        properties: {
          date: { type: ["string", "null"], description: "YYYY-MM-DD" },
          rawDescription: { type: "string", description: "La descripción TAL CUAL figura en el resumen" },
          description: { type: "string", description: "Descripción limpia y legible" },
          amount: { type: "number" },
          currency: { type: "string", enum: ["ARS", "USD"] },
          installmentNumber: { type: ["integer", "null"] },
          installmentsTotal: { type: ["integer", "null"] },
          type: { type: "string", enum: LINE_TYPES },
          categoryId: {
            type: ["string", "null"],
            description:
              "id de una categoría de GASTO. Para montos negativos (reintegros/devoluciones), la categoría del gasto que devuelven (ej. devolución de un impuesto → Impuestos)",
          },
        },
      },
    },
  },
} as const;

interface RawAnalysis {
  cardLast4: string | null;
  cardBrand: string | null;
  cardBank: string | null;
  suggestedCardName: string;
  matchedAccountId: string | null;
  closingDate: string;
  dueDate: string;
  nextClosingDate: string | null;
  nextDueDate: string | null;
  totalARS: number;
  totalUSD: number;
  minimumPayment: number | null;
  lines: Array<{
    date: string | null;
    rawDescription: string;
    description: string;
    amount: number;
    currency: Currency;
    installmentNumber: number | null;
    installmentsTotal: number | null;
    type: StatementLineType;
    categoryId: string | null;
  }>;
}

const monthKeyOf = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
/** "2026-11" + n meses (n puede ser negativo). */
export const addMonthsKey = (period: string, n: number): string => {
  const [y, m] = period.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return monthKeyOf(Math.floor(total / 12), (total % 12) + 1);
};

export const analyzeStatement = async (
  uid: string,
  file: { data: Buffer; mimeType: string; filename: string },
): Promise<StatementAnalysis> => {
  const [accounts, categories, rules] = await Promise.all([
    loadAccounts(uid),
    loadCategories(uid),
    loadCategoryRules(uid),
  ]);
  const cards = accounts.filter((a) => a.type === "credit" && a.active);
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  const system = `Leés resúmenes de tarjeta de crédito argentinos y devolvés sus datos en el JSON pedido.
- Fechas en YYYY-MM-DD (los resúmenes suelen traer DD-MM-YY o "23 Oct 25").
- Incluí TODAS las líneas del detalle, sin inventar ninguna. Montos positivos para consumos y cargos; negativos para pagos, bonificaciones y devoluciones.
- Fijate en qué columna está cada monto (pesos o dólares).
- Tipos: purchase (compra en 1 pago), installment (cuota de una compra en cuotas: completá installmentNumber e installmentsTotal, ej. "03/06" → 3 y 6), subscription (débitos automáticos: Spotify, Netflix, gimnasio…), tax (IVA, sellos, percepciones, IIBB, DB.RG…), fee (comisiones, mantenimiento, seguros del banco), interest (intereses), payment ("SU PAGO"), credit (devoluciones de compras), other. Una bonificación de un impuesto/comisión lleva el mismo tipo que lo que bonifica, con monto negativo.
- rawDescription: el texto exacto de la línea. description: una versión limpia para leer ("COTO CICSA SUC 112" → "Coto", "MERPAGO*RAPPI" → "Rappi"), sin perder el comercio.
- categoryId: SIEMPRE una categoría de GASTO de la lista. Para reintegros, devoluciones y bonificaciones (montos negativos), la del gasto que devuelven: devolución o bonificación de un impuesto/comisión → la de impuestos; devolución de una compra → la categoría de esa compra. Para pagos, null. Respetá las preferencias del usuario de abajo.
- matchedAccountId: si el resumen es de una de las tarjetas del usuario (por últimos 4 dígitos, marca y banco), su id; si no, null.

Tarjetas del usuario:
${cards.map((a) => `- id=${a.id} | "${a.name}"${a.last4 ? ` | termina en ${a.last4}` : ""}`).join("\n") || "(ninguna)"}

Categorías de gasto:
${categories.filter((c) => c.kind === "expense").map((c) => `- id=${c.id} | ${c.name}`).join("\n")}

Categorías de ingreso:
${categories.filter((c) => c.kind === "income").map((c) => `- id=${c.id} | ${c.name}`).join("\n")}

Preferencias del usuario (comercio → categoría que eligió antes):
${rules
  .sort((a, b) => b.count - a.count)
  .slice(0, 150)
  .map((r) => `- ${r.sample} → ${catName.get(r.categoryId) ?? "?"}`)
  .join("\n") || "(todavía ninguna)"}`;

  const base64 = file.data.toString("base64");
  const isPdf = file.mimeType === "application/pdf";
  const completion = await openai().chat.completions.create({
    model: DOCUMENT_MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Este es el resumen." },
          isPdf
            ? { type: "file", file: { filename: file.filename || "resumen.pdf", file_data: `data:application/pdf;base64,${base64}` } }
            : { type: "image_url", image_url: { url: `data:${file.mimeType};base64,${base64}`, detail: "high" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "card_statement", strict: true, schema: SCHEMA as unknown as Record<string, unknown> },
    },
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("La IA no devolvió el análisis");
  const raw = JSON.parse(content) as RawAnalysis;
  if (!isYMD(raw.closingDate) || !isYMD(raw.dueDate)) {
    throw new Error("No pude leer las fechas de cierre y vencimiento del resumen");
  }

  // Tarjeta: últimos 4 dígitos > lo que propuso la IA > nueva.
  const last4 = raw.cardLast4?.replace(/\D/g, "").slice(-4) || null;
  const byLast4 = last4 ? cards.find((a) => a.last4 === last4) : undefined;
  const byAi = cards.find((a) => a.id === raw.matchedAccountId);
  const matched = byLast4 ?? byAi ?? null;

  const ruleByKey = new Map(rules.map((r) => [r.key, r]));
  const catKind = new Map(categories.map((c) => [c.id, c.kind]));
  const lines: AnalyzedLine[] = raw.lines.map((l, index) => {
    // La clave sale del texto original (la versión "limpia" de la IA puede
    // cambiar entre resúmenes: "MERPAGO*RAPPI" → "Mercado Pago Rappi").
    const merchantKey = normalizeMerchant(l.rawDescription || l.description);
    // Siempre categorías de gasto: un reintegro de tarjeta descuenta del gasto
    // que devuelve (ej. devolución de impuesto → Impuestos), no es un ingreso.
    const wantKind = "expense";
    const rule = ruleByKey.get(merchantKey);
    let suggestedCategoryId: string | null = null;
    let categorySource: AnalyzedLine["categorySource"] = null;
    if (l.type !== "payment") {
      if (rule && catKind.get(rule.categoryId) === wantKind) {
        suggestedCategoryId = rule.categoryId;
        categorySource = "rule";
      } else if (l.categoryId && catKind.get(l.categoryId) === wantKind) {
        suggestedCategoryId = l.categoryId;
        categorySource = "ai";
      }
    }
    const hasInstallments = (l.installmentsTotal ?? 0) > 1 && (l.installmentNumber ?? 0) >= 1;
    return {
      index,
      date: l.date && isYMD(l.date) ? l.date : null,
      description: l.description.trim(),
      amount: round2(l.amount),
      currency: l.currency,
      installmentNumber: hasInstallments ? l.installmentNumber : null,
      installmentsTotal: hasInstallments ? l.installmentsTotal : null,
      type: hasInstallments && l.type === "purchase" ? "installment" : l.type,
      merchantKey,
      suggestedCategoryId,
      categorySource,
      duplicateOf: null,
    };
  });

  const period = raw.closingDate.slice(0, 7);
  if (matched) await markDuplicates(uid, matched.id, period, lines);

  return {
    card: {
      last4,
      brand: raw.cardBrand,
      bank: raw.cardBank,
      suggestedName: raw.suggestedCardName || [raw.cardBrand, raw.cardBank].filter(Boolean).join(" ") || "Tarjeta",
    },
    matchedAccountId: matched?.id ?? null,
    closingDate: raw.closingDate,
    dueDate: raw.dueDate,
    nextClosingDate: raw.nextClosingDate && isYMD(raw.nextClosingDate) ? raw.nextClosingDate : null,
    nextDueDate: raw.nextDueDate && isYMD(raw.nextDueDate) ? raw.nextDueDate : null,
    totalARS: round2(raw.totalARS ?? 0),
    totalUSD: round2(raw.totalUSD ?? 0),
    minimumPayment: raw.minimumPayment != null ? round2(raw.minimumPayment) : null,
    lines,
  };
};

/**
 * Marca las líneas que ya estaban cargadas en esa tarjeta:
 * - cuota k/N: una cuota con el mismo número, monto (±1%) y moneda en ese resumen
 * - compra en 1 pago: mismo monto (±1%) y moneda, en este resumen o el anterior,
 *   comprada ±5 días de la fecha de la línea (si la hay)
 */
export const markDuplicates = async (
  uid: string,
  accountId: string,
  period: string,
  lines: AnalyzedLine[],
): Promise<void> => {
  const db = adminDb();
  const [insSnap, txSnap] = await Promise.all([
    db.collection(`users/${uid}/installments`).where("accountId", "==", accountId).get(),
    db.collection(`users/${uid}/transactions`).where("accountId", "==", accountId).get(),
  ]);
  const purchaseDay = new Map(
    txSnap.docs.map((d) => [d.id, (d.data().purchaseDate as Timestamp | undefined)?.toMillis() ?? null]),
  );
  const candidates = insSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) })) as Array<{
    id: string;
    transactionId: string;
    amount: number;
    currency?: Currency;
    kind: string;
    billingMonth: string;
    installmentNumber: number;
    totalInstallments: number;
    projected?: boolean;
  }>;
  const used = new Set<string>();
  const prev = addMonthsKey(period, -1);
  const near = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) <= Math.max(1, Math.abs(b) * 0.01);

  for (const line of lines) {
    if (isPaymentLine(line)) continue;
    const kind = line.amount < 0 ? "income" : "expense";
    const match = candidates.find((c) => {
      // Los estimados (suscripciones proyectadas) no cuentan: se reemplazan al importar.
      if (c.projected) return false;
      if (used.has(c.id) || c.kind !== kind || (c.currency ?? "ARS") !== line.currency) return false;
      if (!near(c.amount, line.amount)) return false;
      if (line.installmentNumber) {
        return c.billingMonth === period && c.installmentNumber === line.installmentNumber;
      }
      if (c.totalInstallments > 1) return false;
      if (c.billingMonth !== period && c.billingMonth !== prev) return false;
      if (!line.date) return true;
      const bought = purchaseDay.get(c.transactionId);
      if (bought == null) return true;
      return Math.abs(bought - dateFromYMD(line.date).getTime()) <= 5 * 24 * 3600 * 1000;
    });
    if (match) {
      used.add(match.id);
      line.duplicateOf = match.transactionId;
    }
  }
};

// === Importación ===

export const importStatement = async (uid: string, payload: ImportPayload): Promise<ImportResult> => {
  const db = adminDb();
  const period = payload.closingDate.slice(0, 7);

  // 1. Tarjeta existente o nueva.
  let accountId: string;
  let createdAccount = false;
  let accounts = await loadAccounts(uid);
  if ("existingId" in payload.account) {
    const acc = accounts.find((a) => a.id === (payload.account as { existingId: string }).existingId);
    if (!acc || acc.type !== "credit") throw new Error("La tarjeta elegida no existe");
    accountId = acc.id;
  } else {
    const parentId = payload.account.parentId;
    const parent = parentId ? accounts.find((a) => a.id === parentId) : null;
    accountId = await createAccountAdmin(uid, {
      name: payload.account.newName.trim(),
      type: "credit",
      closingDay: Number(payload.closingDate.slice(8, 10)),
      dueDay: Number(payload.dueDate.slice(8, 10)),
      parentId: parent && parent.type !== "credit" && parent.type !== "reserve" ? parent.id : null,
      last4: payload.last4,
    });
    createdAccount = true;
    accounts = await loadAccounts(uid);
  }
  const accountName = accounts.find((a) => a.id === accountId)!.name;

  // 2. Resumen, ciclos reales, fechas pendientes y últimos 4 (sin crear gastos).
  const chargeSum = (c: Currency) =>
    round2(
      payload.lines
        .filter((l) => l.currency === c && ["tax", "fee", "interest"].includes(l.type))
        .reduce((acc, l) => acc + l.amount, 0),
    );
  const draft: StatementDraft = {
    type: "statement",
    id: randomUUID().slice(0, 8),
    accountId,
    accountName,
    newCard: null,
    period,
    closingDate: payload.closingDate,
    dueDate: payload.dueDate,
    nextClosingDate: payload.nextClosingDate,
    nextDueDate: payload.nextDueDate,
    last4: payload.last4,
    totalARS: payload.totalARS,
    totalUSD: payload.totalUSD,
    minimumPayment: payload.minimumPayment,
    lines: payload.lines.map((l) => ({
      date: l.date,
      description: l.description,
      amount: l.amount,
      currency: l.currency,
      installment: l.installmentNumber ? `${l.installmentNumber}/${l.installmentsTotal}` : null,
      type: l.type,
    })),
    chargesARS: Math.max(0, chargeSum("ARS")),
    chargesUSD: Math.max(0, chargeSum("USD")),
    chargesCategoryId: null,
    chargesCategoryName: null,
    subscriptions: [],
    createdAt: Date.now(),
  };
  await saveStatementAdmin(uid, draft, "summary");

  // 3. Los estimados de este resumen se reemplazan por lo real (y los del
  //    siguiente se vuelven a proyectar desde este).
  const nextPeriod = addMonthsKey(period, 1);
  await deleteProjected(uid, accountId, [period, nextPeriod]);

  // 4. Consumos elegidos (con la tarjeta ya actualizada).
  accounts = await loadAccounts(uid);
  const account = toServerAccount(accounts.find((a) => a.id === accountId)!);
  const categories = await loadCategories(uid);
  const catKind = new Map(categories.map((c) => [c.id, c.kind]));
  const fallback = (kind: "expense" | "income") =>
    categories.find((c) => c.kind === kind && /^otro/i.test(c.name))?.id ??
    categories.find((c) => c.kind === kind)?.id;

  let created = 0;
  let skipped = 0;
  const learned = new Map<string, { categoryId: string; sample: string }>();
  const subscriptions: ProjectedSubscription[] = [];
  for (const line of payload.lines) {
    if (isPaymentLine(line) || !line.include) {
      if (line.duplicateOf) skipped += 1;
      continue;
    }
    const kind = isCreditLine(line) ? "income" : "expense";
    // Reintegros: con la categoría del gasto que devuelven (de gasto), así en
    // "Por categoría" descuentan de ese gasto. Si no hay, impuestos u "Otros".
    const taxCat = categories.find((c) => c.kind === "expense" && /impuest|comisi/i.test(c.name))?.id;
    const categoryId =
      line.categoryId && catKind.get(line.categoryId) === "expense"
        ? line.categoryId
        : kind === "income" && ["tax", "fee", "interest"].includes(line.type)
          ? (taxCat ?? fallback("expense"))
          : fallback("expense");
    if (!categoryId) continue;
    const amount = Math.abs(line.amount);
    const purchaseDate = dateFromYMD(line.date ?? payload.closingDate);
    const k = line.installmentNumber;
    const n = line.installmentsTotal;

    if (kind === "expense" && k && n && n > 1) {
      // Compra completa en N cuotas: la cuota k cae en este resumen.
      await createTransactionAdmin({
        ownerUid: uid,
        account,
        accountId,
        categoryId,
        description: line.description,
        totalAmount: round2(amount * n),
        purchaseDate,
        kind: "expense",
        installments: n,
        currency: line.currency,
        forceFirstBillingMonth: addMonthsKey(period, -(k - 1)),
      });
    } else {
      await createTransactionAdmin({
        ownerUid: uid,
        account,
        accountId,
        categoryId,
        description: line.description,
        totalAmount: amount,
        purchaseDate,
        kind,
        installments: 1,
        currency: line.currency,
        // Gastos y reintegros quedan en el resumen que se está importando.
        forceFirstBillingMonth: period,
      });
    }
    created += 1;
    if (line.categoryId && line.merchantKey) {
      learned.set(line.merchantKey, { categoryId: line.categoryId, sample: line.description });
    }
  }

  // 5. Suscripciones: se estiman en el resumen siguiente. Van las que se
  //    cargaron y las que ya estaban cargadas (no las que se desmarcaron).
  for (const line of payload.lines) {
    if (line.type !== "subscription" || line.amount <= 0 || line.installmentNumber) continue;
    if (!line.include && !line.duplicateOf) continue;
    const categoryId =
      line.categoryId && catKind.get(line.categoryId) === "expense" ? line.categoryId : fallback("expense");
    if (!categoryId) continue;
    subscriptions.push({
      description: line.description,
      amount: line.amount,
      currency: line.currency,
      categoryId,
      date: line.date ?? payload.closingDate,
    });
  }
  const projected = await projectSubscriptions(uid, account, accountId, nextPeriod, subscriptions);

  // 6. Aprender: comercio → categoría.
  const rulesCol = db.collection(`users/${uid}/categoryRules`);
  const entries = [...learned.entries()];
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const [key, v] of entries.slice(i, i + 400)) {
      batch.set(
        rulesCol.doc(key.replace(/\//g, " ").slice(0, 120) || "sin-nombre"),
        { categoryId: v.categoryId, sample: v.sample, count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    await batch.commit();
  }

  return { accountId, accountName, createdAccount, created, skipped, rulesSaved: learned.size, projected };
};

// === Suscripciones estimadas ===

export interface ProjectedSubscription {
  description: string;
  amount: number;
  currency: Currency;
  categoryId: string;
  /** YYYY-MM-DD del débito en el resumen importado. */
  date: string;
}

/** Borra los gastos estimados de una tarjeta en esos resúmenes (por mes de cierre). */
export const deleteProjected = async (uid: string, accountId: string, periods: string[]) => {
  const db = adminDb();
  const txs = await db
    .collection(`users/${uid}/transactions`)
    .where("accountId", "==", accountId)
    .where("projected", "==", true)
    .get();
  for (const tx of txs.docs) {
    if (!periods.includes(String(tx.data().firstBillingMonth))) continue;
    const ins = await db.collection(`users/${uid}/installments`).where("transactionId", "==", tx.id).get();
    const batch = db.batch();
    ins.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(tx.ref);
    await batch.commit();
  }
};

/** Crea las suscripciones como gastos estimados en el resumen `period`. */
export const projectSubscriptions = async (
  uid: string,
  account: ReturnType<typeof toServerAccount>,
  accountId: string,
  period: string,
  subs: ProjectedSubscription[],
): Promise<number> => {
  let n = 0;
  for (const sub of subs) {
    // Mismo día, un mes después (si el mes es más corto, el último día).
    const [y, m, d] = sub.date.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const next = `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
    await createTransactionAdmin({
      ownerUid: uid,
      account,
      accountId,
      categoryId: sub.categoryId,
      description: sub.description,
      totalAmount: sub.amount,
      purchaseDate: dateFromYMD(next),
      kind: "expense",
      installments: 1,
      currency: sub.currency,
      forceFirstBillingMonth: period,
      projected: true,
    });
    n += 1;
  }
  return n;
};
