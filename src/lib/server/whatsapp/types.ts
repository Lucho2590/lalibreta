import type { Currency } from "@/lib/domain/types";
import type { CreateVaquitaInput, ExpenseInput, MemberInput, PaymentInput } from "../vaquitas";

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
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** Contactos compartidos (📎 → Contacto): uno o varios. */
  contacts?: Array<{
    name?: { formatted_name?: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone?: string; wa_id?: string; type?: string }>;
    emails?: Array<{ email?: string; type?: string }>;
  }>;
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
  currency?: Currency;
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
  /** Dividirlo con otras personas (al confirmar se arma el reparto). */
  split?: SplitDraft | null;
  /** Ítem de una lista al que se vincula al guardarlo (itemId null: se agrega). */
  listItem?: { listId: string; itemId: string | null; listTitle: string; itemTitle: string } | null;
  /** epoch ms */
  createdAt: number;
}

export interface SplitDraftPerson {
  /** null si es alguien nuevo sin la app (se agrega como contacto al confirmar). */
  ref: `u:${string}` | `c:${string}` | null;
  newName?: string | null;
  name: string;
  isApp: boolean;
  shareType: "percent" | "amount";
  value: number;
  /** Su parte, ya calculada. */
  amount: number;
}

export interface SplitDraft {
  mode: "installments" | "lump";
  people: SplitDraftPerson[];
  /** Y de ahora en más, dividir siempre así los gastos de este comercio. */
  always?: boolean;
}

/** Plata con una persona: le pasé / me pasó / le presté. */
export interface PersonTransferDraft {
  type: "person-transfer";
  id: string;
  ref: `u:${string}` | `c:${string}` | null;
  /** Alguien nuevo sin la app: se agrega como contacto al confirmar. */
  newName?: string | null;
  personName: string;
  isApp: boolean;
  direction: "in" | "out";
  kind: "payment" | "loan";
  accountId: string;
  accountName: string;
  amount: number;
  currency: Currency;
  /** YYYY-MM-DD */
  date: string;
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
  currencies?: Array<Currency>;
  isMain?: boolean;
  openingBalances?: Partial<Record<Currency, number>> | null;
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
  currency: Currency;
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
  /** Categoría de gasto sugerida por el agente (opcional). */
  categoryId?: string | null;
}

export interface SubscriptionProposal {
  name: string;
  amount: number;
  /** Default ARS. */
  currency?: Currency;
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
  /**
   * Cómo se eligió la tarjeta: "last4" = termina igual que el resumen;
   * "user" = la dijo el usuario (se respeta aunque la terminación no coincida).
   */
  matchedBy?: "last4" | "user" | null;
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
  fromCurrency: Currency;
  fromAmount: number;
  toCurrency: Currency;
  toAmount: number;
  /** Pesos por dólar. */
  rate: number;
  rateSource: "user" | "BCRA";
  /** Fecha de la cotización BCRA usada (YYYY-MM-DD). */
  rateDate: string | null;
  /** Dónde o con quién cambió ("Mercado Pago", "Mi señora"). Va en la descripción. */
  withWhom?: string | null;
  /** Cotización pactada si los pesos no cierran (rate pasa a ser la efectiva). */
  quotedRate?: number;
  /** Diferencia en pesos contra la pactada (redondeo/comisión). Positivo = a favor. */
  exchangeDiff?: number;
  /** Saldos que quedarían después del cambio (para mostrar). */
  after: Array<{ accountName: string; currency: Currency; amount: number }>;
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
    currency: Currency;
    amount: number;
    payWith: Currency;
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
  currency: Currency;
  amount: number;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  after: Array<{ accountName: string; currency: Currency; amount: number }>;
  /** La cuenta destino no tenía esta moneda: se le agrega al confirmar. */
  addCurrencyToDestination?: boolean;
  createdAt: number;
}

/** Ingreso o gasto fijo (todos los meses). */
export interface RecurringDraft {
  type: "recurring";
  id: string;
  kind: "expense" | "income";
  name: string;
  amount: number;
  currency: Currency;
  accountId: string;
  accountName: string;
  categoryId: string;
  categoryName: string;
  dayOfMonth: number;
  /** YYYY-MM desde cuándo. */
  startMonth: string;
  createdAt: number;
}

/** Un renglón de una carga en lote (lista de gastos de una foto, planilla, etc.). */
export interface BatchDraftLine {
  description: string;
  /** Monto del renglón tal como figura (si es una cuota, el de la cuota). */
  amount: number;
  currency: Currency;
  kind: "expense" | "income";
  /** YYYY-MM-DD de la compra. */
  date: string;
  accountId: string;
  accountName: string;
  accountType: string;
  categoryId: string;
  categoryName: string;
  /**
   * Cuota k de N (solo gastos con tarjeta): se carga la compra completa en N
   * cuotas desde `date`, así la cuota k cae en el resumen que corresponde.
   */
  installmentNumber: number | null;
  installmentsTotal: number | null;
}

/** Varios gastos/ingresos confirmados juntos con un solo botón. */
export interface BatchDraft {
  type: "batch";
  id: string;
  lines: BatchDraftLine[];
  /** Renglones que ya estaban cargados y no se repiten (para mostrar). */
  duplicates: Array<{ description: string; amount: number; currency: Currency }>;
  /** Renglones que no se pueden cargar (cuenta inexistente, moneda que no maneja…). */
  skipped: string[];
  createdAt: number;
}

/** Vaquita: crear una, cargarle un gasto o registrar un pago para saldar. */
export interface VaquitaDraft {
  type: "vaquita";
  id: string;
  op: "create" | "expense" | "payment" | "link" | "add" | "delete";
  vaquitaName: string;
  /** Lo que se manda al server al confirmar (según op). */
  create?: CreateVaquitaInput;
  expense?: ExpenseInput;
  payment?: PaymentInput;
  /** Vincular a alguien "sin la app" con su cuenta. */
  link?: { vaquitaId: string; memberId: string; ref?: string; q?: string; name: string };
  /** Sumar gente a una vaquita que ya existe. */
  add?: { vaquitaId: string; members: MemberInput[] };
  /** Borrar un gasto de la vaquita. */
  remove?: { vaquitaId: string; expenseId: string };
  /** Resumen ya armado para mostrar (título y renglones). */
  title: string;
  lines: string[];
  createdAt: number;
}

export type Draft =
  | TransactionDraft
  | VaquitaDraft
  | BatchDraft
  | AccountDraft
  | StatementDraft
  | ExchangeDraft
  | CardPaymentDraft
  | RecurringDraft
  | TransferDraft
  | PersonTransferDraft;

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
