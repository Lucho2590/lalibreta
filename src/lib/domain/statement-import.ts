import type { Currency, StatementLineType } from "./types";

/**
 * Tipos compartidos entre la web y el server para importar un resumen de
 * tarjeta desde /resumenes.
 */

export type CategorySource = "rule" | "ai";

export interface AnalyzedLine {
  index: number;
  /** YYYY-MM-DD o null si el resumen no la trae. */
  date: string | null;
  description: string;
  /** Positivo = consumo/cargo; negativo = pago, bonificación o devolución. */
  amount: number;
  currency: Currency;
  /** Para compras en cuotas: k de N. */
  installmentNumber: number | null;
  installmentsTotal: number | null;
  type: StatementLineType;
  /** Clave del comercio (normalizeMerchant) para recordar la categoría. */
  merchantKey: string;
  suggestedCategoryId: string | null;
  categorySource: CategorySource | null;
  /** Si ya estaba cargado en la app: id de la transacción. */
  duplicateOf: string | null;
}

export interface StatementAnalysis {
  card: {
    last4: string | null;
    brand: string | null;
    bank: string | null;
    suggestedName: string;
  };
  /** Tarjeta existente a la que corresponde (null = hay que crearla). */
  matchedAccountId: string | null;
  closingDate: string;
  dueDate: string;
  nextClosingDate: string | null;
  nextDueDate: string | null;
  totalARS: number;
  totalUSD: number;
  minimumPayment: number | null;
  lines: AnalyzedLine[];
}

export interface ImportLine extends AnalyzedLine {
  include: boolean;
  categoryId: string | null;
}

export interface ImportPayload {
  account: { existingId: string } | { newName: string; parentId: string | null };
  last4: string | null;
  closingDate: string;
  dueDate: string;
  nextClosingDate: string | null;
  nextDueDate: string | null;
  totalARS: number;
  totalUSD: number;
  minimumPayment: number | null;
  lines: ImportLine[];
}

export interface ImportResult {
  accountId: string;
  accountName: string;
  createdAccount: boolean;
  created: number;
  skipped: number;
  rulesSaved: number;
  /** Suscripciones proyectadas al resumen siguiente. */
  projected: number;
}

/** Las líneas que nunca se cargan (el pago del resumen anterior). */
export const isPaymentLine = (l: Pick<AnalyzedLine, "type">) => l.type === "payment";

/** Las que van como ingreso en la tarjeta (bonificaciones, devoluciones). */
export const isCreditLine = (l: Pick<AnalyzedLine, "type" | "amount">) =>
  !isPaymentLine(l) && l.amount < 0;
