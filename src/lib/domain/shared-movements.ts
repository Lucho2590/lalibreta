import type { Currency, ShareVisibility, TransactionKind } from "./types";

/** Lo que ve el invitado de una cuenta compartida (GET /api/account-shares/movements). */
export interface SharedMovement {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: Currency;
  kind: TransactionKind;
  /** "3/6" si es una cuota. */
  installment: string | null;
  categoryName: string | null;
  createdByName: string | null;
  /** Lo cargó el que está mirando. */
  mine: boolean;
  /** Reintegro / saldo a favor de la tarjeta. */
  credit: boolean;
}

export interface SharedMovementsResponse {
  shareId: string;
  accountName: string;
  accountType: string;
  ownerName: string;
  visibility: ShareVisibility;
  month: string;
  items: SharedMovement[];
  /** Neto de lo que cargó el que mira (gastos − reintegros). */
  mineTotal: Record<Currency, number>;
  /** Total del mes de la cuenta (solo si puede ver todo). */
  accountTotal: Record<Currency, number> | null;
  dueDate: string | null;
}
