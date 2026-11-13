/** Subconjunto del payload del webhook de WhatsApp Cloud API que usamos. */

export interface WaIncomingMessage {
  id: string;
  from: string;
  timestamp: string;
  type:
    | "text"
    | "audio"
    | "image"
    | "interactive"
    | "button"
    | "document"
    | "sticker"
    | "location"
    | "contacts"
    | "video"
    | "reaction"
    | "unsupported"
    | string;
  text?: { body: string };
  audio?: { id: string; mime_type: string; voice?: boolean };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload: string; text: string };
}

export interface WaContact {
  wa_id: string;
  profile?: { name?: string };
}

export interface WaWebhookPayload {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id: string; display_phone_number: string };
        contacts?: WaContact[];
        messages?: WaIncomingMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

/** Movimiento propuesto por el agente, esperando confirmación del usuario. */
export interface TransactionDraft {
  /** Ausente en borradores viejos (antes de que hubiera otros tipos). */
  type?: "transaction";
  id: string;
  kind: "expense" | "income";
  amount: number;
  /** Default ARS. */
  currency?: "ARS" | "USD";
  description: string;
  accountId: string;
  accountName: string;
  accountType: string;
  /** Vacío si la categoría es nueva (newCategory). */
  categoryId: string;
  categoryName: string;
  /** Categoría que no existe todavía: se crea al confirmar. */
  newCategory?: { name: string; kind: "expense" | "income"; icon: string | null } | null;
  /** YYYY-MM-DD */
  date: string;
  installments: number;
  cardClosedAtPurchase: boolean;
  /** Tarjeta sin cierre/vencimiento cargados todavía. */
  cardDatesPending?: boolean;
  /** Gasto sobre una cuenta que otra persona compartió: va a la cuenta del dueño. */
  shared?: { shareId: string; ownerUid: string; ownerName: string } | null;
  /** epoch ms */
  createdAt: number;
}

export interface AccountDraftItem {
  name: string;
  accountType: "cash" | "debit" | "credit" | "checking" | "savings" | "digital" | "reserve";
  closingDay: number | null;
  dueDay: number | null;
  /** Cuenta madre existente. */
  parentId: string | null;
  /** Cuenta madre que se crea en este mismo borrador (por nombre). */
  parentName: string | null;
  last4: string | null;
  /** No aplica a tarjetas. */
  currencies?: Array<"ARS" | "USD">;
  isMain?: boolean;
  openingBalances?: Partial<Record<"ARS" | "USD", number>> | null;
}

/** Una o varias cuentas nuevas, confirmadas juntas. */
export interface AccountDraft {
  type: "account";
  id: string;
  /** Las tarjetas pueden venir sin closingDay/dueDay: quedan con fechas pendientes. */
  accounts: AccountDraftItem[];
  /** Pedidas pero que ya existían. */
  alreadyExisting: string[];
  createdAt: number;
}

export interface StatementDraftLine {
  date: string | null;
  description: string;
  amount: number;
  currency: "ARS" | "USD";
  installment: string | null;
  type:
    | "purchase"
    | "installment"
    | "subscription"
    | "tax"
    | "fee"
    | "interest"
    | "payment"
    | "credit"
    | "other";
}

export interface SubscriptionProposal {
  name: string;
  amount: number;
  /** Default ARS. */
  currency?: "ARS" | "USD";
  categoryId: string;
  categoryName: string;
  dayOfMonth: number;
}

export interface StatementDraft {
  type: "statement";
  id: string;
  /** Tarjeta existente o null si hay que crearla (newCard). */
  accountId: string | null;
  accountName: string;
  newCard: { name: string; parentId: string | null } | null;
  /** YYYY-MM del cierre */
  period: string;
  closingDate: string;
  dueDate: string;
  nextClosingDate: string | null;
  nextDueDate: string | null;
  last4: string | null;
  totalARS: number;
  totalUSD: number;
  minimumPayment: number | null;
  lines: StatementDraftLine[];
  chargesARS: number;
  /** Impuestos/cargos en dólares (se cargan como gasto en USD). */
  chargesUSD?: number;
  chargesCategoryId: string | null;
  chargesCategoryName: string | null;
  subscriptions: SubscriptionProposal[];
  createdAt: number;
}

/** Cambio de moneda (vender/comprar dólares). */
export interface ExchangeDraft {
  type: "exchange";
  id: string;
  fromAccountId: string;
  fromAccountName: string;
  toAccountId: string;
  toAccountName: string;
  fromCurrency: "ARS" | "USD";
  fromAmount: number;
  toCurrency: "ARS" | "USD";
  toAmount: number;
  /** Pesos por dólar. */
  rate: number;
  rateSource: "user" | "BCRA";
  /** Fecha de la cotización BCRA usada (YYYY-MM-DD). */
  rateDate: string | null;
  /** Saldos que quedarían después del cambio (para mostrar). */
  after: Array<{ accountName: string; currency: "ARS" | "USD"; amount: number }>;
  /** YYYY-MM-DD */
  date: string;
  createdAt: number;
}

/** Pago de una tarjeta de crédito desde una cuenta. */
export interface CardPaymentDraft {
  type: "card-payment";
  id: string;
  cardId: string;
  cardName: string;
  fromAccountId: string;
  fromAccountName: string;
  /**
   * Uno o dos pagos. `currency/amount` es la deuda que se cancela;
   * `payWith/payAmount` lo que sale de la cuenta (difieren si se paga la
   * parte en dólares con pesos).
   */
  payments: Array<{
    currency: "ARS" | "USD";
    amount: number;
    payWith: "ARS" | "USD";
    payAmount: number;
    rate: number | null;
  }>;
  /** De dónde salió el monto sugerido. */
  amountSource: "statement" | "app" | "user";
  date: string;
  createdAt: number;
}

/** Transferencia entre cuentas propias (incluye guardar/sacar plata de una cobacha). */
export interface TransferDraft {
  type: "transfer";
  id: string;
  fromAccountId: string;
  fromAccountName: string;
  toAccountId: string;
  toAccountName: string;
  currency: "ARS" | "USD";
  amount: number;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  after: Array<{ accountName: string; currency: "ARS" | "USD"; amount: number }>;
  createdAt: number;
}

/** Ingreso o gasto fijo (todos los meses). */
export interface RecurringDraft {
  type: "recurring";
  id: string;
  kind: "expense" | "income";
  name: string;
  amount: number;
  currency: "ARS" | "USD";
  accountId: string;
  accountName: string;
  categoryId: string;
  categoryName: string;
  dayOfMonth: number;
  /** YYYY-MM desde cuándo. */
  startMonth: string;
  createdAt: number;
}

export type Draft =
  | TransactionDraft
  | AccountDraft
  | StatementDraft
  | ExchangeDraft
  | CardPaymentDraft
  | RecurringDraft
  | TransferDraft;

export type DraftType = NonNullable<Draft["type"]>;

export const draftType = (d: Draft): DraftType => d.type ?? "transaction";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface WhatsappSession {
  uid: string;
  history: ChatTurn[];
  pendingDraft: Draft | null;
  /** epoch ms */
  updatedAt: number;
}
