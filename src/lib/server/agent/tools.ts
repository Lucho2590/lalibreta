import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import {
  getCardStatement,
  getMonthSummary,
  listRecentTransactions,
  toServerAccount,
  type ServerAccountInfo,
  type ServerCategoryInfo,
  type ServerRecurringInfo,
} from "../queries-admin";
import { getLatestStatement, getStatementHistory } from "../statements-admin";
import { getUsdRate } from "../fx";
import type { BalancesSnapshot } from "../queries-admin";
import type { Currency } from "@/lib/domain/types";
import { setAccountBalanceAdmin, setCardDatesAdmin } from "../accounts-admin";
import { CATEGORY_ICON_IDS, createCategoryAdmin } from "../categories-admin";
import {
  createShareCode,
  displayNameOf,
  notifyUser,
  redeemShareCode,
  revokeShare,
  type MyShare,
  type SharedWithMe,
} from "../sharing";
import { currentMonthKey, formatShortDateAR, isMonthKey, isYMD, todayYMD } from "../time";
import type {
  AccountDraft,
  AccountDraftItem,
  CardPaymentDraft,
  Draft,
  ExchangeDraft,
  RecurringDraft,
  StatementDraft,
  TransferDraft,
  StatementDraftLine,
  TransactionDraft,
} from "../whatsapp/types";

export interface ToolContext {
  uid: string;
  accounts: ServerAccountInfo[];
  categories: ServerCategoryInfo[];
  recurring: ServerRecurringInfo[];
  /** Saldos actuales de cuentas y deuda de tarjetas. */
  balances: BalancesSnapshot;
  /** Cuentas de otros compartidas conmigo (con los datos de la cuenta del dueño). */
  sharedWithMe: Array<SharedWithMe & { account: ServerAccountInfo }>;
  /** Cuentas mías compartidas con otros. */
  myShares: MyShare[];
  /** Borrador que ya estaba esperando confirmación (para corregirlo). */
  pendingDraft: Draft | null;
  /** Lo completa una herramienta propose_* cuando arma un borrador válido. */
  proposedDraft: Draft | null;
}

const ACCOUNT_TYPES = ["cash", "debit", "credit", "checking", "savings", "digital", "reserve"] as const;
const LINE_TYPES = [
  "purchase",
  "installment",
  "subscription",
  "tax",
  "fee",
  "interest",
  "payment",
  "credit",
  "other",
] as const;

export const TOOL_DEFINITIONS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "propose_transaction",
      description:
        "Arma un gasto o ingreso para que el usuario lo confirme con un botón. No lo guarda: el sistema le manda al usuario un resumen con botones Confirmar/Cancelar.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["expense", "income"] },
          amount: { type: "number", description: "Monto total, positivo, en la moneda indicada" },
          currency: {
            type: "string",
            enum: ["ARS", "USD"],
            description: "Moneda del monto (por defecto ARS). USD si dice dólares/USD/u$s/verdes.",
          },
          description: { type: "string", description: "Descripción corta" },
          accountId: { type: "string", description: "id de la cuenta (de la lista)" },
          categoryId: {
            type: "string",
            description: "id de una categoría EXISTENTE (de la lista y del mismo tipo que kind). Omitir si se usa newCategoryName.",
          },
          newCategoryName: {
            type: "string",
            description:
              'Si el usuario pide una categoría que NO existe (ej. "Verdulería"): su nombre. Se crea al confirmar. No usar si existe una con ese nombre.',
          },
          newCategoryIcon: {
            type: "string",
            enum: [...CATEGORY_ICON_IDS],
            description: "Ícono para la categoría nueva",
          },
          date: { type: "string", description: "Fecha de la compra, YYYY-MM-DD" },
          installments: {
            type: "integer",
            description: "Cantidad de cuotas (1 si no es tarjeta de crédito)",
          },
          cardClosedAtPurchase: {
            type: "boolean",
            description: "true si la tarjeta ya había cerrado al momento de la compra",
          },
        },
        required: ["kind", "amount", "description", "accountId", "date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_accounts",
      description:
        "Arma UNA O VARIAS cuentas nuevas (efectivo, banco, billetera, tarjeta de crédito) para que el usuario las confirme juntas con un botón. Si pide varias, mandalas todas en una sola llamada. Las fechas de cierre/vencimiento de las tarjetas son OPCIONALES: si no las sabe, la tarjeta se crea con fechas pendientes y se completan después (set_card_dates o con el resumen).",
      parameters: {
        type: "object",
        properties: {
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: 'Nombre visible, ej. "Efectivo", "Visa Galicia". Corregí errores de tipeo obvios (Mastar → Master).',
                },
                type: {
                  type: "string",
                  enum: [...ACCOUNT_TYPES],
                  description:
                    "cash=efectivo, debit=tarjeta de débito, credit=tarjeta de crédito, checking=cuenta corriente, savings=caja de ahorro, digital=billetera digital (Mercado Pago, Ualá, etc.), reserve=COBACHA: plata apartada DENTRO de otra cuenta (reservas de Mercado Pago, frascos de Naranja X, apartados del banco); necesita parentId/parentName y tiene UNA moneda",
                },
                closingDay: { type: "integer", description: "Solo crédito: día de cierre (1-31), si lo sabés" },
                dueDay: { type: "integer", description: "Solo crédito: día de vencimiento (1-31), si lo sabés" },
                parentId: {
                  type: "string",
                  description:
                    "Crédito (opcional) o cobacha (obligatorio): id de la cuenta EXISTENTE a la que pertenece (banco, Mercado Pago…)",
                },
                parentName: {
                  type: "string",
                  description: "Crédito o cobacha: nombre de la cuenta madre si se crea en esta misma lista",
                },
                last4: { type: "string", description: "Solo crédito, opcional: últimos 4 dígitos" },
                currencies: {
                  type: "array",
                  items: { type: "string", enum: ["ARS", "USD"] },
                  description:
                    "No crédito: monedas que maneja (ej. banco con caja de ahorro en pesos y en dólares → [\"ARS\",\"USD\"]). Por defecto [\"ARS\"]. Efectivo en dólares → [\"USD\"].",
                },
                isMain: {
                  type: "boolean",
                  description: "true si es la cuenta principal (donde cobra). Solo una.",
                },
                openingARS: { type: "number", description: "Saldo actual en pesos, si lo dijo" },
                openingUSD: { type: "number", description: "Saldo actual en dólares, si lo dijo" },
              },
              required: ["name", "type"],
              additionalProperties: false,
            },
          },
        },
        required: ["accounts"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_category",
      description:
        "Crea una categoría nueva en el momento (sin botones), cuando el usuario lo pide explícitamente (\"creame la categoría Verdulería\"). Para un gasto con una categoría que no existe, preferí propose_transaction con newCategoryName.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["expense", "income"] },
          icon: { type: "string", enum: [...CATEGORY_ICON_IDS] },
        },
        required: ["name", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_card_dates",
      description:
        "Guarda el día de cierre y de vencimiento de una tarjeta de crédito existente (por ejemplo una creada con fechas pendientes). Se aplica en el momento, sin botones. Si estaban pendientes, reacomoda en el resumen correcto las cuotas de los gastos cargados mientras tanto.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "id de la tarjeta" },
          closingDay: { type: "integer", description: "Día de cierre (1-31)" },
          dueDay: { type: "integer", description: "Día de vencimiento (1-31)" },
        },
        required: ["accountId", "closingDay", "dueDay"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "register_card_statement",
      description:
        "Registra los datos leídos de un resumen de tarjeta de crédito (PDF o foto). El usuario lo confirma con botones antes de guardarlo. Guarda cierres y vencimientos reales, el detalle de líneas, y (si el usuario elige 'Guardar todo') carga los impuestos y cargos como un gasto y da de alta las suscripciones como gastos fijos.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "id de la tarjeta de crédito existente a la que corresponde el resumen. Omitir si hay que crear la tarjeta (usar newCardName).",
          },
          newCardName: {
            type: "string",
            description:
              'Solo si la tarjeta no existe en la lista: nombre para crearla, ej. "Visa Galicia".',
          },
          newCardParentId: {
            type: "string",
            description: "Opcional, con newCardName: id de la cuenta bancaria de la que depende",
          },
          last4: { type: "string", description: "Últimos 4 dígitos de la tarjeta, si figuran" },
          closingDate: { type: "string", description: "Fecha de cierre de este resumen, YYYY-MM-DD" },
          dueDate: { type: "string", description: "Fecha de vencimiento de este resumen, YYYY-MM-DD" },
          nextClosingDate: { type: "string", description: "Próximo cierre, YYYY-MM-DD, si figura" },
          nextDueDate: { type: "string", description: "Próximo vencimiento, YYYY-MM-DD, si figura" },
          totalARS: { type: "number", description: "Saldo/total a pagar en pesos" },
          totalUSD: { type: "number", description: "Saldo/total a pagar en dólares (0 si no hay)" },
          minimumPayment: { type: "number", description: "Pago mínimo en pesos, si figura" },
          lines: {
            type: "array",
            description:
              "TODAS las líneas del detalle del resumen. Montos positivos para cargos; negativos para pagos, bonificaciones y devoluciones.",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "YYYY-MM-DD o vacío si no tiene" },
                description: { type: "string" },
                amount: { type: "number" },
                currency: { type: "string", enum: ["ARS", "USD"] },
                installment: {
                  type: "string",
                  description: 'Cuota, ej. "3/6"; vacío si no es en cuotas',
                },
                type: {
                  type: "string",
                  enum: [...LINE_TYPES],
                  description:
                    "purchase=compra en 1 pago, installment=cuota de compra en cuotas, subscription=débito automático recurrente (Spotify, Netflix, YouTube, gimnasio, seguros de terceros...), tax=impuestos (IVA, sellos, percepciones, IIBB, Ganancias, DB.RG...), fee=comisiones y cargos del banco (mantenimiento, renovación, seguro de vida del banco...), interest=intereses (financiación, punitorios), payment=su pago, credit=bonificaciones/devoluciones, other=otro",
                },
              },
              required: ["description", "amount", "currency", "type"],
              additionalProperties: false,
            },
          },
          chargesCategoryId: {
            type: "string",
            description:
              "id de la categoría de GASTO para cargar los impuestos y cargos del banco (ej. Impuestos, Bancos, Servicios). Obligatorio si hay líneas tax/fee/interest.",
          },
          subscriptions: {
            type: "array",
            description:
              "Suscripciones (en pesos o dólares) para proponer como fijos, sin repetir las que ya están en la lista de fijos de esa tarjeta.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: 'Nombre limpio, ej. "Spotify", "YouTube Premium"' },
                amount: { type: "number" },
                currency: { type: "string", enum: ["ARS", "USD"] },
                categoryId: { type: "string", description: "id de categoría de gasto" },
                dayOfMonth: { type: "integer", description: "Día del mes en que se debita" },
              },
              required: ["name", "amount", "categoryId", "dayOfMonth"],
              additionalProperties: false,
            },
          },
        },
        required: ["closingDate", "dueDate", "totalARS", "lines"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_statement_draft",
      description:
        "Corrige el resumen de tarjeta que está esperando confirmación (otra tarjeta, otra categoría para los cargos, quitar o cambiar suscripciones, fechas, últimos 4 dígitos) sin volver a leer el documento. Solo los campos que cambian.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          newCardName: { type: "string" },
          newCardParentId: { type: "string" },
          last4: { type: "string" },
          closingDate: { type: "string" },
          dueDate: { type: "string" },
          nextClosingDate: { type: "string" },
          nextDueDate: { type: "string" },
          chargesCategoryId: { type: "string" },
          subscriptions: {
            type: "array",
            description: "Lista COMPLETA de suscripciones a dar de alta (reemplaza la anterior; [] para ninguna)",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                amount: { type: "number" },
                currency: { type: "string", enum: ["ARS", "USD"] },
                categoryId: { type: "string" },
                dayOfMonth: { type: "integer" },
              },
              required: ["name", "amount", "categoryId", "dayOfMonth"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_exchange",
      description:
        "Cambio de moneda: vender dólares (\"vendí 500 USD a 1480\") o comprar (\"compré 200 dólares\"). Si el usuario no dice a cuánto, se usa la cotización oficial del BCRA. Por defecto en la cuenta principal (puede ser la misma cuenta: salen dólares y entran pesos). Se confirma con botones.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["sell_usd", "buy_usd"] },
          usdAmount: { type: "number", description: "Cantidad de dólares" },
          rate: { type: "number", description: "Pesos por dólar, si el usuario lo dijo" },
          arsAmount: {
            type: "number",
            description: "Pesos totales, si el usuario dijo cuántos pesos recibió/pagó en vez de la cotización",
          },
          fromAccountId: { type: "string", description: "Cuenta de donde sale la plata (opcional)" },
          toAccountId: { type: "string", description: "Cuenta a donde entra (opcional; puede ser la misma)" },
          date: { type: "string", description: "YYYY-MM-DD, por defecto hoy" },
        },
        required: ["operation", "usdAmount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_card_payment",
      description:
        "Pago de una tarjeta de crédito (\"pagué la visa\"). Si no dice el monto, se usa el total del último resumen guardado (o lo que la app tiene a pagar). Sale de la cuenta a la que está asociada la tarjeta o de la principal. La parte en dólares se puede pagar con dólares o con pesos. Se confirma con botones.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "id de la tarjeta" },
          fromAccountId: { type: "string", description: "Cuenta de donde sale el pago (opcional)" },
          amountARS: { type: "number", description: "Monto en pesos, si lo dijo" },
          amountUSD: { type: "number", description: "Monto en dólares, si lo dijo" },
          payUSDWith: {
            type: "string",
            enum: ["USD", "ARS"],
            description: "Con qué paga la parte en dólares (por defecto USD si la cuenta tiene dólares)",
          },
          date: { type: "string", description: "YYYY-MM-DD, por defecto hoy" },
        },
        required: ["cardId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_transfer",
      description:
        "Mover plata entre cuentas propias en la MISMA moneda: \"pasé 100 lucas del Galicia a Mercado Pago\", guardar en una cobacha (\"guardé 50 lucas en la cobacha Vacaciones\") o sacar de una (\"saqué 20 lucas de la reserva\"). No es gasto ni ingreso. Para cambiar de moneda usá propose_exchange; para pagar una tarjeta, propose_card_payment. Se confirma con botones.",
      parameters: {
        type: "object",
        properties: {
          fromAccountId: {
            type: "string",
            description: "Cuenta de donde sale. Si va a una cobacha y no se dice, se usa la cuenta madre.",
          },
          toAccountId: {
            type: "string",
            description: "Cuenta a donde entra. Si sale de una cobacha y no se dice, se usa la cuenta madre.",
          },
          amount: { type: "number" },
          currency: { type: "string", enum: ["ARS", "USD"] },
          date: { type: "string", description: "YYYY-MM-DD, por defecto hoy" },
        },
        required: ["amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_recurring",
      description:
        "Ingreso o gasto FIJO que se repite todos los meses (\"cobro 2500 USD todos los 5\", \"pago 450 lucas de alquiler el 10\"). Queda en Fijos. Se confirma con botones.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["income", "expense"] },
          name: { type: "string", description: 'Nombre, ej. "Sueldo", "Alquiler"' },
          amount: { type: "number" },
          currency: { type: "string", enum: ["ARS", "USD"] },
          accountId: { type: "string", description: "Cuenta (por defecto la principal)" },
          categoryId: { type: "string", description: "Categoría del mismo tipo que kind" },
          dayOfMonth: { type: "integer", description: "Día del mes (1-31)" },
        },
        required: ["kind", "name", "amount", "currency", "dayOfMonth"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_account_balance",
      description:
        "Fija o ajusta el SALDO de una cuenta existente (no tarjeta), sin que cuente como ingreso ni gasto: \"tengo 46100 pesos y 172 dólares en el Galicia\", \"agregale 46100 de saldo a la caja de ahorro\", \"corregí el saldo del efectivo a 20000\". Se aplica en el momento. Si la cuenta no tenía esa moneda, se la agrega.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          mode: {
            type: "string",
            enum: ["set", "add"],
            description:
              "set = el saldo actual pasa a ser ese monto (\"tengo X\", \"el saldo es X\"); add = sumar al saldo (\"agregale X\", \"sumale X\")",
          },
          ARS: { type: "number", description: "Monto en pesos" },
          USD: { type: "number", description: "Monto en dólares" },
        },
        required: ["accountId", "mode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_share_code",
      description:
        "Genera un código para COMPARTIR una cuenta propia con otra persona (\"quiero compartir la Visa con mi señora\"). La otra persona se lo pasa a su agente y queda conectada: puede cargar gastos en esa cuenta (entran directo y te avisan) y consultarla. El código vale 24 h y sirve una vez. Se crea en el momento.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "id de la cuenta propia a compartir" },
          withWhom: { type: "string", description: 'Con quién (ej. "mi señora", "Orne"), para el mensaje' },
        },
        required: ["accountId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "join_shared_account",
      description:
        "Usa un código de 6 dígitos que otra persona le pasó al usuario para unirse a su cuenta compartida (\"me pasaron el código 482913\", \"unirme 482913\").",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "Código de 6 dígitos" } },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shared_account_summary",
      description:
        "Consulta una cuenta que OTRA persona compartió con el usuario: gastos del mes, y si es tarjeta, cuánto se paga y cuándo vence. Solo de esa cuenta.",
      parameters: {
        type: "object",
        properties: {
          shareId: { type: "string" },
          month: { type: "string", description: "YYYY-MM, por defecto el actual" },
        },
        required: ["shareId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_sharing",
      description:
        "Deja de compartir una cuenta (lo puede hacer el dueño o quien la recibió): \"dejá de compartir la Visa con Orne\", \"salí de la cuenta compartida de Luciano\".",
      parameters: {
        type: "object",
        properties: { shareId: { type: "string" } },
        required: ["shareId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balances",
      description:
        "Saldos actuales: cuánto hay en cada cuenta (en pesos y dólares), cuánto se debe de cada tarjeta, el total disponible y su equivalente en pesos (cotización BCRA).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fx_rate",
      description: "Cotización oficial del dólar según el BCRA (de hoy o de una fecha).",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD (opcional)" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_spending_summary",
      description:
        "Totales de un mes: ingresos, gastos, balance, gastos por categoría y por cuenta. Se puede filtrar por categoría o por cuenta.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM. Por defecto, el mes actual" },
          categoryId: { type: "string" },
          accountId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_card_statement",
      description:
        "Lo que la app tiene cargado para pagar de una tarjeta en un mes (cuotas y gastos cargados), con la fecha de vencimiento.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "id de la tarjeta" },
          month: { type: "string", description: "YYYY-MM. Por defecto, el mes actual" },
        },
        required: ["accountId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_card_statements_history",
      description:
        "Historial de resúmenes de tarjeta que el usuario mandó: totales, impuestos y cargos del banco (con detalle y % sobre lo consumido), suscripciones, cierres y vencimientos. Sirve para estimar cuánto cobra el banco de impuestos/cargos, comparar meses y detectar suscripciones.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "id de la tarjeta; si se omite, todas" },
          limit: { type: "integer", description: "Cuántos resúmenes (1-24, por defecto 6)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recent_transactions",
      description: "Últimos movimientos cargados, del más nuevo al más viejo.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Cuántos traer (1-20, por defecto 5)" },
        },
        additionalProperties: false,
      },
    },
  },
];

// ---------- Schemas ----------

// El modelo a veces manda "" en vez de omitir un campo opcional.
const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const optYMD = optStr.refine((v) => !v || isYMD(v), "las fechas deben ser YYYY-MM-DD");

const proposeSchema = z.object({
  kind: z.enum(["expense", "income"]),
  amount: z.number().positive().max(1_000_000_000),
  currency: z.enum(["ARS", "USD"]).optional(),
  description: z.string().trim().min(1).max(200),
  accountId: z.string().min(1),
  categoryId: optStr,
  newCategoryName: optStr,
  newCategoryIcon: optStr,
  date: z.string().refine(isYMD, "date debe ser YYYY-MM-DD"),
  installments: z.number().int().min(1).max(36).optional(),
  cardClosedAtPurchase: z.boolean().optional(),
});

const accountItemSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(ACCOUNT_TYPES),
  closingDay: z.number().int().min(1).max(31).optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  parentId: optStr,
  parentName: optStr,
  last4: optStr.refine((v) => !v || /^\d{4}$/.test(v), "last4 debe tener 4 dígitos"),
  currencies: z.array(z.enum(["ARS", "USD"])).optional(),
  isMain: z.boolean().optional(),
  openingARS: z.number().optional(),
  openingUSD: z.number().optional(),
});

const categorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(["expense", "income"]),
  icon: optStr,
});

const exchangeSchema = z.object({
  operation: z.enum(["sell_usd", "buy_usd"]),
  usdAmount: z.number().positive(),
  rate: z.number().positive().optional(),
  arsAmount: z.number().positive().optional(),
  fromAccountId: optStr,
  toAccountId: optStr,
  date: optYMD,
});

const cardPaymentSchema = z.object({
  cardId: z.string().min(1),
  fromAccountId: optStr,
  amountARS: z.number().nonnegative().optional(),
  amountUSD: z.number().nonnegative().optional(),
  payUSDWith: z.enum(["USD", "ARS"]).optional(),
  date: optYMD,
});

const recurringSchema = z.object({
  kind: z.enum(["income", "expense"]),
  name: z.string().trim().min(1).max(60),
  amount: z.number().positive(),
  currency: z.enum(["ARS", "USD"]),
  accountId: optStr,
  categoryId: optStr,
  dayOfMonth: z.number().int().min(1).max(31),
});

const fxSchema = z.object({ date: optYMD });

const shareCodeSchema = z.object({ accountId: z.string().min(1), withWhom: optStr });
const joinSchema = z.object({
  code: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length === 6, "El código tiene 6 dígitos"),
});
const sharedSummarySchema = z.object({
  shareId: z.string().min(1),
  month: z.string().refine(isMonthKey, "month debe ser YYYY-MM").optional(),
});
const stopSharingSchema = z.object({ shareId: z.string().min(1) });

const transferSchema = z.object({
  fromAccountId: optStr,
  toAccountId: optStr,
  amount: z.number().positive(),
  currency: z.enum(["ARS", "USD"]).optional(),
  date: optYMD,
});

const balanceSchema = z.object({
  accountId: z.string().min(1),
  mode: z.enum(["set", "add"]),
  ARS: z.number().optional(),
  USD: z.number().optional(),
});

const cardDatesSchema = z.object({
  accountId: z.string().min(1),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
});

const accountsSchema = z.object({
  accounts: z.array(accountItemSchema).min(1).max(15),
});

const statementSchema = z.object({
  accountId: optStr,
  newCardName: optStr,
  newCardParentId: optStr,
  last4: optStr.refine((v) => !v || /^\d{4}$/.test(v), "last4 debe tener 4 dígitos"),
  closingDate: z.string().refine(isYMD, "closingDate debe ser YYYY-MM-DD"),
  dueDate: z.string().refine(isYMD, "dueDate debe ser YYYY-MM-DD"),
  nextClosingDate: optYMD,
  nextDueDate: optYMD,
  totalARS: z.number(),
  totalUSD: z.number().optional(),
  minimumPayment: z.number().optional(),
  lines: z
    .array(
      z.object({
        date: optYMD,
        description: z.string().trim().min(1).max(200),
        amount: z.number(),
        currency: z.enum(["ARS", "USD"]),
        installment: optStr,
        type: z.enum(LINE_TYPES),
      }),
    )
    .max(400),
  chargesCategoryId: optStr,
  subscriptions: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        amount: z.number().positive(),
        currency: z.enum(["ARS", "USD"]).optional(),
        categoryId: z.string().min(1),
        dayOfMonth: z.number().int().min(1).max(31),
      }),
    )
    .max(30)
    .optional(),
});

const summarySchema = z.object({
  month: z.string().refine(isMonthKey, "month debe ser YYYY-MM").optional(),
  categoryId: z.string().optional(),
  accountId: z.string().optional(),
});

const cardSchema = z.object({
  accountId: z.string().min(1),
  month: z.string().refine(isMonthKey, "month debe ser YYYY-MM").optional(),
});

const historySchema = z.object({
  accountId: optStr,
  limit: z.number().int().min(1).max(24).optional(),
});

const recentSchema = z.object({
  limit: z.number().int().min(1).max(20).optional(),
});

type ToolResult = Record<string, unknown>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const newId = () => randomUUID().slice(0, 8);
const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** Para detectar nombres repetidos: "Mercado Pago" == "MercadoPago" == "mercado-pago". */
const sameName = (a: string, b: string) =>
  normalize(a).replace(/ /g, "") === normalize(b).replace(/ /g, "");
const issues = (e: z.ZodError) => ({ error: e.issues.map((i) => i.message).join("; ") });

const BUILT_MESSAGE =
  "Borrador listo. El sistema le manda el resumen al usuario con los botones. No agregues nada más.";

// ---------- propose_transaction ----------

const proposeTransaction = (ctx: ToolContext, raw: unknown): ToolResult => {
  const parsed = proposeSchema.safeParse(raw);
  if (!parsed.success) return issues(parsed.error);
  const args = parsed.data;

  // Cuenta propia o compartida conmigo ("shared:<shareId>").
  const sharedEntry = args.accountId.startsWith("shared:")
    ? ctx.sharedWithMe.find((s) => s.shareId === args.accountId.slice("shared:".length))
    : undefined;
  if (args.accountId.startsWith("shared:") && !sharedEntry) {
    return { error: "Esa cuenta compartida ya no está disponible." };
  }
  if (sharedEntry && args.kind !== "expense") {
    return { error: "En una cuenta compartida solo se cargan gastos." };
  }
  const account = sharedEntry
    ? sharedEntry.account
    : ctx.accounts.find((a) => a.id === args.accountId && a.active);
  if (!account) return { error: "La cuenta no existe o está inactiva. Usá un id de la lista." };
  const currency: Currency = args.currency ?? "ARS";
  if (!account.currencies.includes(currency)) {
    return {
      error: `La cuenta "${account.name}" no maneja ${currency === "USD" ? "dólares" : "pesos"}. Usá otra cuenta o preguntale al usuario.`,
    };
  }

  // Categoría existente o nueva (se crea al confirmar).
  let category: ServerCategoryInfo | undefined;
  let newCategory: TransactionDraft["newCategory"] = null;
  if (args.categoryId) {
    category = ctx.categories.find((c) => c.id === args.categoryId);
    if (!category) return { error: "La categoría no existe. Usá un id de la lista o newCategoryName." };
    if (category.kind !== args.kind) {
      return { error: `La categoría "${category.name}" es de tipo ${category.kind}, no ${args.kind}.` };
    }
  } else if (args.newCategoryName) {
    category = ctx.categories.find(
      (c) => c.kind === args.kind && sameName(c.name, args.newCategoryName!),
    );
    if (!category) {
      newCategory = {
        name: args.newCategoryName,
        kind: args.kind,
        icon: args.newCategoryIcon ?? null,
      };
    }
  } else {
    return { error: "Falta la categoría: pasá categoryId (existente) o newCategoryName (nueva)." };
  }

  const isCreditExpense = account.type === "credit" && args.kind === "expense";
  const draft: TransactionDraft = {
    type: "transaction",
    id: newId(),
    kind: args.kind,
    amount: round2(args.amount),
    currency,
    description: args.description,
    accountId: account.id,
    accountName: sharedEntry ? `${account.name} (de ${sharedEntry.ownerName})` : account.name,
    accountType: account.type,
    shared: sharedEntry
      ? { shareId: sharedEntry.shareId, ownerUid: sharedEntry.ownerUid, ownerName: sharedEntry.ownerName }
      : null,
    categoryId: category?.id ?? "",
    categoryName: category?.name ?? newCategory!.name,
    newCategory,
    date: args.date,
    installments: isCreditExpense ? (args.installments ?? 1) : 1,
    cardClosedAtPurchase: isCreditExpense ? (args.cardClosedAtPurchase ?? false) : false,
    cardDatesPending: isCreditExpense && (!account.defaultClosingDay || !account.defaultDueDay),
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};

// ---------- propose_accounts ----------

/** Monedas, principal y saldo inicial de una cuenta que no es tarjeta. */
const accountMoneyFields = (a: z.infer<typeof accountItemSchema>) => {
  const currencies: Currency[] = a.currencies?.length
    ? [...new Set(a.currencies)]
    : a.openingUSD && !a.openingARS
      ? ["USD"]
      : ["ARS"];
  if (a.openingUSD && !currencies.includes("USD")) currencies.push("USD");
  if (a.openingARS && !currencies.includes("ARS")) currencies.unshift("ARS");
  const opening: Partial<Record<Currency, number>> = {};
  if (a.openingARS) opening.ARS = round2(a.openingARS);
  if (a.openingUSD) opening.USD = round2(a.openingUSD);
  return {
    currencies,
    isMain: a.isMain === true,
    openingBalances: Object.keys(opening).length ? opening : null,
  };
};

const proposeAccounts = (ctx: ToolContext, raw: unknown): ToolResult => {
  const parsed = accountsSchema.safeParse(raw);
  if (!parsed.success) return issues(parsed.error);

  const items: AccountDraftItem[] = [];
  const alreadyExisting: string[] = [];

  for (const a of parsed.data.accounts) {
    const existing = ctx.accounts.find((x) => sameName(x.name, a.name));
    if (existing) {
      alreadyExisting.push(existing.name);
      continue;
    }
    if (items.some((x) => sameName(x.name, a.name))) continue;
    const isCredit = a.type === "credit";
    const isReserve = a.type === "reserve";
    // Fechas opcionales: van las dos o ninguna.
    const hasDates = Boolean(isCredit && a.closingDay && a.dueDay);

    let parentId: string | null = null;
    let parentName: string | null = null;
    if ((isCredit || isReserve) && a.parentId) {
      const parent = ctx.accounts.find((x) => x.id === a.parentId);
      if (parent && parent.type !== "credit" && parent.type !== "reserve" && !parent.parentId && parent.active) {
        parentId = parent.id;
        parentName = parent.name;
      }
    } else if ((isCredit || isReserve) && a.parentName) {
      // Se resuelve al confirmar, si esa cuenta está en la misma lista.
      parentName = a.parentName;
    }
    if (isReserve && !parentId && !parentName) {
      return {
        error: `La cobacha "${a.name}" tiene que estar dentro de una cuenta (Mercado Pago, el banco…). Preguntale de cuál es.`,
      };
    }

    items.push({
      name: a.name,
      accountType: a.type,
      closingDay: hasDates ? a.closingDay! : null,
      dueDay: hasDates ? a.dueDay! : null,
      parentId,
      parentName,
      last4: isCredit ? (a.last4 ?? null) : null,
      ...(isCredit ? {} : accountMoneyFields(a)),
      ...(isReserve
        ? (() => {
            // Una cobacha tiene una sola moneda y nunca es la principal.
            const f = accountMoneyFields(a);
            const cur: Currency = a.currencies?.[0] ?? (a.openingUSD && !a.openingARS ? "USD" : "ARS");
            const opening = f.openingBalances?.[cur];
            return {
              currencies: [cur],
              isMain: false,
              openingBalances: opening ? { [cur]: opening } : null,
            };
          })()
        : {}),
    });
  }
  // Una sola principal: si marcó varias, queda la primera.
  let mainSeen = false;
  for (const it of items) {
    if (it.isMain && mainSeen) it.isMain = false;
    if (it.isMain) mainSeen = true;
  }

  // La cuenta madre por nombre solo vale si es otra cuenta no-crédito de la lista.
  for (const it of items) {
    if (it.parentName && !it.parentId) {
      const ok = items.some(
        (x) =>
          x !== it &&
          x.accountType !== "credit" &&
          x.accountType !== "reserve" &&
          sameName(x.name, it.parentName!),
      );
      if (!ok) it.parentName = null;
    }
  }

  if (items.length === 0) {
    return { error: `Esas cuentas ya existen: ${alreadyExisting.join(", ")}. Decíselo al usuario.` };
  }

  const draft: AccountDraft = {
    type: "account",
    id: newId(),
    accounts: items,
    alreadyExisting,
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};

// ---------- register_card_statement ----------

const FALLBACK_PATTERNS = [/suscrip/, /entreten/, /servicio/, /^otro/];

const fallbackExpenseCategory = (
  ctx: ToolContext,
  last?: ServerCategoryInfo,
): ServerCategoryInfo | undefined => {
  const expense = ctx.categories.filter((c) => c.kind === "expense");
  for (const re of FALLBACK_PATTERNS) {
    const hit = expense.find((c) => re.test(normalize(c.name)));
    if (hit) return hit;
  }
  return last ?? expense[0];
};

const CHARGE_TYPES = new Set(["tax", "fee", "interest"]);

const registerStatement = (ctx: ToolContext, raw: unknown): ToolResult => {
  const parsed = statementSchema.safeParse(raw);
  if (!parsed.success) return issues(parsed.error);
  const args = parsed.data;

  if (args.closingDate >= args.dueDate) {
    return { error: "El vencimiento tiene que ser posterior al cierre. Revisá las fechas del resumen." };
  }
  if (args.nextClosingDate && args.nextClosingDate <= args.closingDate) {
    return { error: "El próximo cierre tiene que ser posterior al cierre actual." };
  }

  // Tarjeta existente o nueva.
  let accountId: string | null = null;
  let accountName: string;
  let newCard: StatementDraft["newCard"] = null;
  if (args.accountId) {
    const acc = ctx.accounts.find((a) => a.id === args.accountId);
    if (!acc) return { error: "La tarjeta no existe. Usá un id de la lista o newCardName." };
    if (acc.type !== "credit") return { error: `"${acc.name}" no es una tarjeta de crédito.` };
    accountId = acc.id;
    accountName = acc.name;
  } else if (args.newCardName) {
    const dup = ctx.accounts.find((a) => sameName(a.name, args.newCardName!));
    if (dup) {
      return { error: `Ya existe una cuenta "${dup.name}". Si es esta tarjeta, usá su accountId.` };
    }
    if (args.newCardParentId) {
      const parent = ctx.accounts.find((a) => a.id === args.newCardParentId);
      if (!parent || parent.type === "credit" || parent.parentId) {
        return { error: "newCardParentId tiene que ser una cuenta bancaria (no tarjeta)." };
      }
    }
    accountName = args.newCardName;
    newCard = { name: args.newCardName, parentId: args.newCardParentId ?? null };
  } else {
    return { error: "Falta la tarjeta: pasá accountId (si existe) o newCardName (para crearla)." };
  }

  const lines: StatementDraftLine[] = args.lines.map((l) => ({
    date: l.date ?? null,
    description: l.description,
    amount: round2(l.amount),
    currency: l.currency,
    installment: l.installment ?? null,
    type: l.type,
  }));

  const chargesARS = round2(
    lines
      .filter((l) => l.currency === "ARS" && CHARGE_TYPES.has(l.type))
      .reduce((acc, l) => acc + l.amount, 0),
  );

  const chargesUSD = round2(
    lines
      .filter((l) => l.currency === "USD" && CHARGE_TYPES.has(l.type))
      .reduce((acc, l) => acc + l.amount, 0),
  );

  let chargesCategory: ServerCategoryInfo | undefined;
  if (chargesARS > 0 || chargesUSD > 0) {
    chargesCategory =
      ctx.categories.find((c) => c.id === args.chargesCategoryId && c.kind === "expense") ??
      ctx.categories.find((c) => c.kind === "expense" && /impuest|banc|comision/.test(normalize(c.name))) ??
      fallbackExpenseCategory(ctx);
    if (!chargesCategory) {
      return { error: "El usuario no tiene categorías de gasto: pedile que cree una en la app." };
    }
  }

  // Suscripciones: categoría válida y sin repetir gastos fijos existentes de la tarjeta.
  const existingFixed = new Set(
    ctx.recurring
      .filter((r) => accountId && r.accountId === accountId)
      .map((r) => normalize(r.name)),
  );
  const subscriptions: StatementDraft["subscriptions"] = [];
  for (const sub of args.subscriptions ?? []) {
    // Si el modelo eligió mal la categoría, usamos la más razonable en vez de
    // rechazar todo el resumen (que obligaría a releer el PDF).
    const cat =
      ctx.categories.find((c) => c.id === sub.categoryId && c.kind === "expense") ??
      fallbackExpenseCategory(ctx, chargesCategory);
    if (!cat) continue;
    if (existingFixed.has(normalize(sub.name))) continue;
    subscriptions.push({
      name: sub.name,
      amount: round2(sub.amount),
      currency: sub.currency ?? "ARS",
      categoryId: cat.id,
      categoryName: cat.name,
      dayOfMonth: sub.dayOfMonth,
    });
  }

  const draft: StatementDraft = {
    type: "statement",
    id: newId(),
    accountId,
    accountName,
    newCard,
    period: args.closingDate.slice(0, 7),
    closingDate: args.closingDate,
    dueDate: args.dueDate,
    nextClosingDate: args.nextClosingDate ?? null,
    nextDueDate: args.nextDueDate ?? null,
    last4: args.last4 ?? null,
    totalARS: round2(args.totalARS),
    totalUSD: round2(args.totalUSD ?? 0),
    minimumPayment: args.minimumPayment != null ? round2(args.minimumPayment) : null,
    lines,
    chargesARS: chargesARS > 0 ? chargesARS : 0,
    chargesUSD: chargesUSD > 0 ? chargesUSD : 0,
    chargesCategoryId: chargesCategory?.id ?? null,
    chargesCategoryName: chargesCategory?.name ?? null,
    subscriptions,
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};

// ---------- update_statement_draft ----------

const updateStatementDraft = (ctx: ToolContext, raw: unknown): ToolResult => {
  // Puede corregir el que armó en esta misma vuelta o el que estaba pendiente.
  const current = ctx.proposedDraft ?? ctx.pendingDraft;
  if (!current || current.type !== "statement") {
    return { error: "No hay un resumen esperando confirmación. Pedile al usuario que lo mande de nuevo." };
  }
  if (typeof raw !== "object" || raw === null) return { error: "Argumentos inválidos" };
  const patch = raw as Record<string, unknown>;

  // Reconstruimos los argumentos originales y aplicamos el cambio; así se
  // valida todo igual que la primera vez.
  const base: Record<string, unknown> = {
    accountId: current.accountId ?? undefined,
    newCardName: current.newCard?.name,
    newCardParentId: current.newCard?.parentId ?? undefined,
    last4: current.last4 ?? undefined,
    closingDate: current.closingDate,
    dueDate: current.dueDate,
    nextClosingDate: current.nextClosingDate ?? undefined,
    nextDueDate: current.nextDueDate ?? undefined,
    totalARS: current.totalARS,
    totalUSD: current.totalUSD,
    minimumPayment: current.minimumPayment ?? undefined,
    lines: current.lines.map((l) => ({
      date: l.date ?? undefined,
      description: l.description,
      amount: l.amount,
      currency: l.currency,
      installment: l.installment ?? undefined,
      type: l.type,
    })),
    chargesCategoryId: current.chargesCategoryId ?? undefined,
    subscriptions: current.subscriptions.map((x) => ({
      name: x.name,
      amount: x.amount,
      currency: x.currency ?? "ARS",
      categoryId: x.categoryId,
      dayOfMonth: x.dayOfMonth,
    })),
  };
  // Cambiar de tarjeta existente a nueva (o al revés) limpia la otra opción.
  if (patch.accountId) {
    base.newCardName = undefined;
    base.newCardParentId = undefined;
  }
  if (patch.newCardName) base.accountId = undefined;

  return registerStatement(ctx, { ...base, ...patch });
};

// ---------- helpers de cuentas ----------

const mainAccount = (ctx: ToolContext) =>
  ctx.accounts.find((a) => a.isMain && a.active && a.type !== "credit");

const currencyWords = (cs: Currency[]) =>
  cs.map((c) => (c === "USD" ? "dólares" : "pesos")).join(" y ");

/** Cuenta (no tarjeta) que maneje esas monedas: la pedida, la principal o la única posible. */
const pickAccount = (
  ctx: ToolContext,
  requestedId: string | undefined,
  needs: Currency[],
): { account?: ServerAccountInfo; error?: string } => {
  const fits = (a: ServerAccountInfo, allowReserve = false) =>
    a.active &&
    a.type !== "credit" &&
    (allowReserve || a.type !== "reserve") &&
    needs.every((c) => a.currencies.includes(c));
  if (requestedId) {
    const a = ctx.accounts.find((x) => x.id === requestedId);
    if (a && fits(a, true)) return { account: a };
    if (!a) return { error: "Cuenta inexistente" };
    if (!fits(a)) return { error: `"${a.name}" no maneja ${currencyWords(needs)}.` };
    return { account: a };
  }
  const main = mainAccount(ctx);
  if (main && fits(main)) return { account: main };
  const candidates = ctx.accounts.filter((a) => fits(a));
  if (candidates.length === 1) return { account: candidates[0] };
  return {
    error:
      candidates.length === 0
        ? `No hay ninguna cuenta con ${currencyWords(needs)}. Ofrecé crear una o agregarle esa moneda a una existente desde la app.`
        : `Hay varias cuentas posibles (${candidates.map((c) => c.name).join(", ")}): preguntale cuál.`,
  };
};

const balanceOf = (ctx: ToolContext, accountId: string, c: Currency) =>
  ctx.balances.accounts.find((a) => a.id === accountId)?.amounts[c] ?? 0;

// ---------- propose_exchange ----------

const proposeExchange = async (ctx: ToolContext, raw: unknown): Promise<ToolResult> => {
  const parsed = exchangeSchema.safeParse(raw);
  if (!parsed.success) return issues(parsed.error);
  const args = parsed.data;
  const fromCurrency: Currency = args.operation === "sell_usd" ? "USD" : "ARS";
  const toCurrency: Currency = args.operation === "sell_usd" ? "ARS" : "USD";

  const from = pickAccount(ctx, args.fromAccountId, [fromCurrency]);
  if (!from.account) return { error: from.error };
  // Por defecto, la misma cuenta si maneja las dos monedas.
  const to = args.toAccountId
    ? pickAccount(ctx, args.toAccountId, [toCurrency])
    : from.account.currencies.includes(toCurrency)
      ? { account: from.account }
      : pickAccount(ctx, undefined, [toCurrency]);
  if (!to.account) return { error: to.error };

  let rate = args.rate;
  let rateSource: ExchangeDraft["rateSource"] = "user";
  let rateDate: string | null = null;
  if (!rate && args.arsAmount) rate = args.arsAmount / args.usdAmount;
  if (!rate) {
    try {
      const fx = await getUsdRate(args.date ?? todayYMD());
      rate = fx.rate;
      rateSource = "BCRA";
      rateDate = fx.date;
    } catch {
      return { error: "No pude consultar la cotización del BCRA. Pedile al usuario a cuánto cambió." };
    }
  }
  const ars = round2(args.arsAmount ?? args.usdAmount * rate);
  const usd = round2(args.usdAmount);
  const fromAmount = fromCurrency === "USD" ? usd : ars;
  const toAmount = toCurrency === "USD" ? usd : ars;

  const after: ExchangeDraft["after"] = [];
  const pushAfter = (acc: ServerAccountInfo, c: Currency, delta: number) => {
    const existing = after.find((x) => x.accountName === acc.name && x.currency === c);
    if (existing) existing.amount = round2(existing.amount + delta);
    else after.push({ accountName: acc.name, currency: c, amount: round2(balanceOf(ctx, acc.id, c) + delta) });
  };
  pushAfter(from.account, fromCurrency, -fromAmount);
  pushAfter(to.account, toCurrency, toAmount);

  const draft: ExchangeDraft = {
    type: "exchange",
    id: newId(),
    fromAccountId: from.account.id,
    fromAccountName: from.account.name,
    toAccountId: to.account.id,
    toAccountName: to.account.name,
    fromCurrency,
    fromAmount,
    toCurrency,
    toAmount,
    rate: round2(rate),
    rateSource,
    rateDate,
    after,
    date: args.date ?? todayYMD(),
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};

// ---------- propose_card_payment ----------

const proposeCardPayment = async (ctx: ToolContext, raw: unknown): Promise<ToolResult> => {
  const parsed = cardPaymentSchema.safeParse(raw);
  if (!parsed.success) return issues(parsed.error);
  const args = parsed.data;
  const card = ctx.accounts.find((a) => a.id === args.cardId);
  if (!card) return { error: "Tarjeta inexistente" };
  if (card.type !== "credit") return { error: `"${card.name}" no es una tarjeta de crédito` };

  // Monto: lo que dijo el usuario, o el último resumen, o lo que debe según la app.
  let ars = args.amountARS;
  let usd = args.amountUSD;
  let amountSource: CardPaymentDraft["amountSource"] = "user";
  if (ars == null && usd == null) {
    const st = await getLatestStatement(ctx.uid, card.id);
    if (st && (st.totalARS > 0 || st.totalUSD > 0)) {
      ars = st.totalARS;
      usd = st.totalUSD;
      amountSource = "statement";
    } else {
      const debt = ctx.balances.accounts.find((a) => a.id === card.id)?.amounts;
      ars = Math.max(0, debt?.ARS ?? 0);
      usd = Math.max(0, debt?.USD ?? 0);
      amountSource = "app";
    }
  }
  ars = round2(ars ?? 0);
  usd = round2(usd ?? 0);
  if (ars <= 0 && usd <= 0) {
    return { error: "No encontré nada para pagar de esa tarjeta. Preguntale al usuario cuánto pagó." };
  }

  // Cuenta: la pedida, la asociada a la tarjeta o la principal.
  const needs: Currency[] = [];
  if (ars > 0 || (usd > 0 && args.payUSDWith === "ARS")) needs.push("ARS");
  if (usd > 0 && args.payUSDWith === "USD") needs.push("USD");
  if (needs.length === 0) needs.push("USD");
  const preferred = args.fromAccountId ?? card.parentId ?? undefined;
  let from = pickAccount(ctx, preferred, needs);
  // Si la cuenta asociada no sirve, probamos con la principal / única.
  if (!from.account && !args.fromAccountId && preferred) from = pickAccount(ctx, undefined, needs);
  if (!from.account) return { error: from.error };

  const payments: CardPaymentDraft["payments"] = [];
  if (ars > 0) payments.push({ currency: "ARS", amount: ars, payWith: "ARS", payAmount: ars, rate: null });
  if (usd > 0) {
    const payWith: Currency =
      args.payUSDWith ?? (from.account.currencies.includes("USD") ? "USD" : "ARS");
    if (payWith === "USD") {
      payments.push({ currency: "USD", amount: usd, payWith: "USD", payAmount: usd, rate: null });
    } else {
      let rate: number;
      try {
        rate = (await getUsdRate(args.date ?? todayYMD())).rate;
      } catch {
        return { error: "No pude consultar la cotización para pasar los dólares a pesos." };
      }
      payments.push({ currency: "USD", amount: usd, payWith: "ARS", payAmount: round2(usd * rate), rate });
    }
  }

  const draft: CardPaymentDraft = {
    type: "card-payment",
    id: newId(),
    cardId: card.id,
    cardName: card.name,
    fromAccountId: from.account.id,
    fromAccountName: from.account.name,
    payments,
    amountSource,
    date: args.date ?? todayYMD(),
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};

// ---------- propose_transfer ----------

const proposeTransfer = (ctx: ToolContext, raw: unknown): ToolResult => {
  const parsed = transferSchema.safeParse(raw);
  if (!parsed.success) return issues(parsed.error);
  const args = parsed.data;
  const byId = (id?: string) => (id ? ctx.accounts.find((a) => a.id === id && a.active) : undefined);

  let from = byId(args.fromAccountId);
  let to = byId(args.toAccountId);
  if (args.fromAccountId && !from) return { error: "La cuenta de origen no existe." };
  if (args.toAccountId && !to) return { error: "La cuenta de destino no existe." };
  // Cobachas: si falta un lado, es la cuenta madre.
  if (!from && to?.type === "reserve" && to.parentId) from = byId(to.parentId);
  if (!to && from?.type === "reserve" && from.parentId) to = byId(from.parentId);
  if (!from || !to) return { error: "Falta de qué cuenta sale o a cuál entra: preguntale." };
  if (from.id === to.id) return { error: "Origen y destino son la misma cuenta." };
  if (from.type === "credit" || to.type === "credit") {
    return { error: "Con tarjetas no se transfiere: para pagarla usá propose_card_payment." };
  }

  const shared = from.currencies.filter((c) => to!.currencies.includes(c));
  const currency: Currency | undefined = args.currency ?? (shared.length === 1 ? shared[0] : shared.includes("ARS") ? "ARS" : undefined);
  if (!currency || !from.currencies.includes(currency) || !to.currencies.includes(currency)) {
    return {
      error: `"${from.name}" y "${to.name}" no comparten esa moneda. Si es un cambio de pesos a dólares (o al revés), usá propose_exchange.`,
    };
  }

  const amount = round2(args.amount);
  const after: TransferDraft["after"] = [
    { accountName: from.name, currency, amount: round2(balanceOf(ctx, from.id, currency) - amount) },
    { accountName: to.name, currency, amount: round2(balanceOf(ctx, to.id, currency) + amount) },
  ];
  const description =
    to.type === "reserve"
      ? `Guardado en ${to.name}`
      : from.type === "reserve"
        ? `Retiro de ${from.name}`
        : `Transferencia a ${to.name}`;

  const draft: TransferDraft = {
    type: "transfer",
    id: newId(),
    fromAccountId: from.id,
    fromAccountName: from.name,
    toAccountId: to.id,
    toAccountName: to.name,
    currency,
    amount,
    description,
    date: args.date ?? todayYMD(),
    after,
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};


// ---------- propose_recurring ----------

const proposeRecurring = (ctx: ToolContext, raw: unknown): ToolResult => {
  const parsed = recurringSchema.safeParse(raw);
  if (!parsed.success) return issues(parsed.error);
  const args = parsed.data;

  let account: ServerAccountInfo | undefined;
  if (args.accountId) {
    account = ctx.accounts.find((a) => a.id === args.accountId && a.active);
    if (!account) return { error: "Cuenta inexistente" };
    if (!account.currencies.includes(args.currency)) {
      return { error: `"${account.name}" no maneja ${currencyWords([args.currency])}.` };
    }
  } else {
    const picked = pickAccount(ctx, undefined, [args.currency]);
    if (!picked.account) return { error: picked.error };
    account = picked.account;
  }

  const category =
    ctx.categories.find((c) => c.id === args.categoryId && c.kind === args.kind) ??
    (args.kind === "income"
      ? (ctx.categories.find((c) => c.kind === "income" && /sueldo|salario/.test(normalize(c.name))) ??
        ctx.categories.find((c) => c.kind === "income"))
      : fallbackExpenseCategory(ctx));
  if (!category) return { error: "No hay categorías de ese tipo: pedile que cree una." };

  const draft: RecurringDraft = {
    type: "recurring",
    id: newId(),
    kind: args.kind,
    name: args.name,
    amount: round2(args.amount),
    currency: args.currency,
    accountId: account.id,
    accountName: account.name,
    categoryId: category.id,
    categoryName: category.name,
    dayOfMonth: args.dayOfMonth,
    startMonth: currentMonthKey(),
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};


// ---------- Ejecutor ----------

const resolveAccount = (ctx: ToolContext, id?: string) =>
  id ? ctx.accounts.find((a) => a.id === id) : undefined;

export const executeTool = async (
  ctx: ToolContext,
  name: string,
  rawArgs: string,
): Promise<ToolResult> => {
  let args: unknown;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { error: "Argumentos JSON inválidos" };
  }

  switch (name) {
    case "propose_transaction":
      return proposeTransaction(ctx, args);

    case "propose_accounts":
      return proposeAccounts(ctx, args);

    case "create_category": {
      const parsed = categorySchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const dup = ctx.categories.find(
        (c) => c.kind === parsed.data.kind && sameName(c.name, parsed.data.name),
      );
      if (dup) return { ok: true, alreadyExisted: true, id: dup.id, name: dup.name };
      const r = await createCategoryAdmin(ctx.uid, parsed.data);
      ctx.categories.push({ id: r.id, name: r.name, kind: parsed.data.kind });
      return { ok: true, created: r.created, id: r.id, name: r.name };
    }

    case "set_card_dates": {
      const parsed = cardDatesSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const account = resolveAccount(ctx, parsed.data.accountId);
      if (!account) return { error: "Cuenta inexistente" };
      if (account.type !== "credit") return { error: `"${account.name}" no es una tarjeta de crédito` };
      const r = await setCardDatesAdmin(
        ctx.uid,
        toServerAccount(account),
        parsed.data.closingDay,
        parsed.data.dueDay,
      );
      account.defaultClosingDay = parsed.data.closingDay;
      account.defaultDueDay = parsed.data.dueDay;
      return {
        ok: true,
        card: account.name,
        closingDay: parsed.data.closingDay,
        dueDay: parsed.data.dueDay,
        reorganizedPurchases: r.rebuilt,
        note: r.wasPending
          ? "Fechas guardadas. Si reorganizedPurchases > 0, contale que acomodó esos gastos en el resumen que corresponde."
          : "Fechas actualizadas para los próximos gastos.",
      };
    }

    case "register_card_statement":
      return registerStatement(ctx, args);

    case "update_statement_draft":
      return updateStatementDraft(ctx, args);

    case "propose_exchange":
      return proposeExchange(ctx, args);

    case "propose_card_payment":
      return proposeCardPayment(ctx, args);

    case "propose_recurring":
      return proposeRecurring(ctx, args);

    case "propose_transfer":
      return proposeTransfer(ctx, args);

    case "set_account_balance": {
      const parsed = balanceSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const { accountId, mode, ARS, USD } = parsed.data;
      const account = resolveAccount(ctx, accountId);
      if (!account) return { error: "Cuenta inexistente" };
      if (account.type === "credit") {
        return { error: "Las tarjetas no tienen saldo: lo que se debe sale de los gastos y pagos." };
      }
      if (ARS == null && USD == null) return { error: "Falta el monto (ARS y/o USD)." };
      // Mismo objeto que ctx.balances: si hay otra llamada en esta vuelta, ve el saldo ya ajustado.
      const entry = ctx.balances.accounts.find((a) => a.id === account.id);
      const current = entry?.amounts ?? { ARS: 0, USD: 0 };
      const amounts: Partial<Record<Currency, number>> = {};
      if (ARS != null) amounts.ARS = ARS;
      if (USD != null) amounts.USD = USD;
      const result = await setAccountBalanceAdmin(ctx.uid, account, current, amounts, mode);
      for (const c of Object.keys(amounts) as Currency[]) {
        if (!account.currencies.includes(c)) account.currencies.push(c);
      }
      return {
        ok: true,
        account: account.name,
        newBalance: result,
        note: "Saldo actualizado (no cuenta como ingreso). Confirmale al usuario cómo quedó.",
      };
    }

    case "create_share_code": {
      const parsed = shareCodeSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const account = ctx.accounts.find((a) => a.id === parsed.data.accountId && a.active);
      if (!account) return { error: "Esa cuenta no existe (o no es tuya)." };
      if (account.type === "reserve") return { error: "Las cobachas no se comparten; compartí la cuenta madre." };
      const { code } = await createShareCode(ctx.uid, account);
      return {
        ok: true,
        code,
        account: account.name,
        validHours: 24,
        forwardMessage: `unirme a la cuenta compartida ${code}`,
        note: "Decile el código y que la otra persona le mande a SU agente el forwardMessage (o el código). Vale 24 h y sirve una vez. Mostrá el código bien visible (en negrita).",
      };
    }

    case "join_shared_account": {
      const parsed = joinSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const r = await redeemShareCode(ctx.uid, parsed.data.code);
      if (!r.ok) {
        const msg = {
          invalid: "Ese código no existe. Pedile a la otra persona que te lo pase de nuevo.",
          expired: "Ese código venció (duran 24 h). Pedile uno nuevo.",
          own: "Ese código es de una cuenta tuya: se lo tenés que pasar a la otra persona.",
          "account-gone": "La cuenta de ese código ya no existe.",
        }[r.reason];
        return { error: msg };
      }
      if (!r.alreadyHad) {
        const me = await displayNameOf(ctx.uid);
        await notifyUser(
          r.share.ownerUid,
          `🤝 *${me}* ya comparte tu *${r.share.accountName}*. Lo que cargue ahí entra directo y te aviso.`,
        );
      }
      return {
        ok: true,
        alreadyHad: r.alreadyHad,
        account: r.share.accountName,
        owner: r.share.ownerName,
        shareId: r.share.shareId,
        note: "Contale que ya puede cargar gastos en esa cuenta (entran directo a la cuenta del dueño y le avisa) y consultarla.",
      };
    }

    case "get_shared_account_summary": {
      const parsed = sharedSummarySchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const entry = ctx.sharedWithMe.find((s) => s.shareId === parsed.data.shareId);
      if (!entry) return { error: "Esa cuenta compartida no está disponible." };
      const month = parsed.data.month ?? currentMonthKey();
      if (entry.account.type === "credit") {
        const st = await getCardStatement(entry.ownerUid, entry.account, month);
        return { account: entry.account.name, owner: entry.ownerName, ...st, dueDate: formatShortDateAR(st.dueDate) };
      }
      const fx = await getUsdRate().catch(() => null);
      const summary = await getMonthSummary(entry.ownerUid, month, { accountId: entry.accountId }, fx?.rate ?? null);
      return {
        account: entry.account.name,
        owner: entry.ownerName,
        month,
        expenses: { ARS: summary.byCurrency.ARS.expense, USD: summary.byCurrency.USD.expense },
        byCategoryARS: summary.byCategoryARS,
      };
    }

    case "stop_sharing": {
      const parsed = stopSharingSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const r = await revokeShare(ctx.uid, parsed.data.shareId);
      if (!r.ok || !r.share) return { error: "No encontré ese compartido." };
      const me = await displayNameOf(ctx.uid);
      const other = r.share.ownerUid === ctx.uid ? r.share.granteeUid : r.share.ownerUid;
      if (other) await notifyUser(other, `🔒 ${me} dejó de compartir la cuenta *${r.share.accountName}*.`);
      return { ok: true, account: r.share.accountName };
    }


    case "get_balances": {
      const fx = await getUsdRate().catch(() => null);
      const b = ctx.balances;
      return {
        accounts: b.accounts.map((a) => ({
          name: a.name,
          kind: a.type === "credit" ? "tarjeta (lo que se debe)" : a.isMain ? "cuenta principal" : "cuenta",
          ARS: a.amounts.ARS,
          USD: a.amounts.USD,
        })),
        available: b.available,
        cardDebt: b.cardDebt,
        usdRate: fx ? { rate: fx.rate, date: fx.date, source: "BCRA oficial" } : null,
        availableInARS: fx ? round2(b.available.ARS + b.available.USD * fx.rate) : null,
      };
    }

    case "get_fx_rate": {
      const parsed = fxSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      try {
        const fx = await getUsdRate(parsed.data.date);
        return { rate: fx.rate, date: fx.date, source: "BCRA (cotización oficial de referencia)" };
      } catch {
        return { error: "No pude consultar el BCRA ahora." };
      }
    }

    case "get_spending_summary": {
      const parsed = summarySchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const { month, categoryId, accountId } = parsed.data;
      if (accountId && !resolveAccount(ctx, accountId)) return { error: "Cuenta inexistente" };
      if (categoryId && !ctx.categories.some((c) => c.id === categoryId)) {
        return { error: "Categoría inexistente" };
      }
      const fx = await getUsdRate().catch(() => null);
      const summary = await getMonthSummary(
        ctx.uid,
        month ?? currentMonthKey(),
        { categoryId, accountId },
        fx?.rate ?? null,
      );
      return {
        ...summary,
        note: "byCurrency: totales en cada moneda. byCategoryARS/byAccountARS: en pesos, con los dólares convertidos a la cotización BCRA (usdRateUsed).",
      };
    }

    case "get_card_statement": {
      const parsed = cardSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const account = resolveAccount(ctx, parsed.data.accountId);
      if (!account) return { error: "Cuenta inexistente" };
      if (account.type !== "credit") return { error: `"${account.name}" no es una tarjeta de crédito` };
      const st = await getCardStatement(ctx.uid, account, parsed.data.month ?? currentMonthKey());
      return { ...st, dueDate: formatShortDateAR(st.dueDate) };
    }

    case "get_card_statements_history": {
      const parsed = historySchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      if (parsed.data.accountId && !resolveAccount(ctx, parsed.data.accountId)) {
        return { error: "Cuenta inexistente" };
      }
      const history = await getStatementHistory(ctx.uid, {
        accountId: parsed.data.accountId,
        limit: parsed.data.limit ?? 6,
      });
      if (history.length === 0) {
        return {
          statements: [],
          note: "Todavía no hay resúmenes guardados. El usuario puede mandar el PDF o una foto del resumen.",
        };
      }
      // Promedios por tarjeta para estimar el próximo resumen.
      const byAccount = new Map<string, { n: number; charges: number; pct: number; pctN: number }>();
      for (const h of history) {
        const acc = byAccount.get(h.account) ?? { n: 0, charges: 0, pct: 0, pctN: 0 };
        acc.n += 1;
        acc.charges += h.chargesARS;
        if (h.chargesPct != null) {
          acc.pct += h.chargesPct;
          acc.pctN += 1;
        }
        byAccount.set(h.account, acc);
      }
      return {
        statements: history,
        averages: [...byAccount.entries()].map(([account, a]) => ({
          account,
          statements: a.n,
          avgChargesARS: round2(a.charges / a.n),
          avgChargesPctOfConsumption: a.pctN ? round2(a.pct / a.pctN) : null,
        })),
      };
    }

    case "list_recent_transactions": {
      const parsed = recentSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const list = await listRecentTransactions(ctx.uid, parsed.data.limit ?? 5);
      return {
        transactions: list.map((t) => ({ ...t, date: formatShortDateAR(t.date) })),
      };
    }

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
};
