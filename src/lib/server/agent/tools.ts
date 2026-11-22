import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { exchangeDiffOf } from "@/lib/domain/exchanges";
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
import { getRate, getRates, getUsdRate, tryGetAppRates } from "../fx";
import type { BalancesSnapshot } from "../queries-admin";
import { CURRENCIES, CURRENCY_META, nonZeroCurrencies, zeroMoney, type Currency } from "@/lib/domain/types";
import { sumInARS } from "@/lib/domain/balance";
import { setAccountBalanceAdmin, setAccountParentAdmin, setCardDatesAdmin } from "../accounts-admin";
import { PROPOSE_BATCH_TOOL, proposeBatch } from "./batch-tool";
import { AGENDA_TOOLS, AGENDA_TOOL_NAMES, runAgendaTool } from "./agenda-tool";
import { WEATHER_TOOLS, WEATHER_TOOL_NAMES, runWeatherTool } from "./weather-tool";
import { WATCH_TOOLS, WATCH_TOOL_NAMES, runWatchTool } from "./watch-tool";
import { CONTACTS_TOOLS, CONTACTS_TOOL_NAMES, runContactsTool } from "./contacts-tool";
import { personMatchScore } from "@/lib/domain/contact-info";
import { LISTS_TOOLS, LISTS_TOOL_NAMES, resolveItems, resolveNode, runListsTool } from "./lists-tool";
import { VAQUITA_TOOLS, VAQUITA_TOOL_NAMES, runVaquitaTool } from "./vaquitas-tool";
import { loadActor, loadTreeFor } from "../lists";
import { canEdit, myRole, nodePath } from "@/lib/domain/list-model";
import type { AgentPending, AgentPerson } from "../people";
import { ensureOfflineContact, loadPeopleContext } from "../people";
import { createSplitRule, deleteSplitRule, loadSplitRules } from "../split-rules";
import { normalizeMerchant } from "@/lib/domain/merchants";
import { adminDb } from "../firebase-admin";
import { PeopleError, respondConnection } from "../connections";
import { respondSplit } from "../splits";
import { respondPersonTransfer } from "../person-transfers";
import { computeShares, type PersonRef } from "@/lib/domain/people";
import { computePeopleLedger, ledgerTotal } from "@/lib/domain/debts";
import { CATEGORY_ICON_IDS, createCategoryAdmin } from "../categories-admin";
import {
  REDEEM_ERRORS,
  createShareCode,
  displayNameOf,
  joinWithCode,
  revokeShare,
  type MyShare,
  type SharedWithMe,
} from "../sharing";
import { notify } from "../notifications";
import { loadSharedMovements } from "../shared-movements";
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
  PersonTransferDraft,
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
  /** Mensajes que el sistema manda aparte, tal cual (ej. la invitación para reenviar). */
  outbox: string[];
  /** Gente con la que puede dividir gastos o transferir (conectados + sin app). */
  people: AgentPerson[];
  /** Lo que le mandaron y tiene que responder. */
  pending: AgentPending[];
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
            enum: CURRENCIES,
            description: "Moneda del monto (por defecto ARS). USD si dice dólares/USD/u$s/verdes; EUR euros, GBP libras, BRL reales, UYU pesos uruguayos, CLP pesos chilenos.",
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
          split: {
            type: "object",
            description: 'Solo gastos: dividirlo con otras personas ("la mitad es de Orne", "30 lucas son de Juan").',
            properties: {
              people: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    person: { type: "string", description: "person de la lista Personas" },
                    newName: { type: "string", description: "Alguien SIN la app que no está en Personas (se agrega)" },
                    percent: { type: "number" },
                    amount: { type: "number" },
                  },
                  additionalProperties: false,
                },
              },
              mode: { type: "string", enum: ["installments", "lump"], description: "En cuotas: si te lo paga en cuotas (default) o todo junto" },
              always: { type: "boolean", description: 'true si pide dividir SIEMPRE así este gasto ("todos los meses", "siempre")' },
            },
            required: ["people"],
            additionalProperties: false,
          },
          listItem: {
            type: "object",
            description:
              'Solo gastos: si lo que pagó es un ítem de una de sus listas ("pagué 5000 la yerba de la lista del super", "compré la torta del cumple"). Al guardarlo queda vinculado al ítem, lo tacha y suma al gasto de la lista. Si el ítem no existe, se agrega.',
            properties: {
              list: { type: "string", description: "id o nombre de la lista (de get_lists)" },
              item: { type: "string", description: "id o nombre del ítem" },
            },
            required: ["list", "item"],
            additionalProperties: false,
          },
        },
        required: ["kind", "amount", "description", "accountId", "date"],
        additionalProperties: false,
      },
    },
  },
  PROPOSE_BATCH_TOOL,
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
                  items: { type: "string", enum: CURRENCIES },
                  description:
                    "No crédito: monedas que maneja (ej. banco con caja de ahorro en pesos y en dólares → [\"ARS\",\"USD\"]). Por defecto [\"ARS\"]. Efectivo en dólares → [\"USD\"]. Cuenta en euros → [\"EUR\"].",
                },
                isMain: {
                  type: "boolean",
                  description: "true si es la cuenta principal (donde cobra). Solo una.",
                },
                opening: {
                  type: "array",
                  description:
                    'Saldo actual por moneda, si lo dijo (ej. "tengo 3000 dólares y 150 lucas" → [{currency:"USD",amount:3000},{currency:"ARS",amount:150000}])',
                  items: {
                    type: "object",
                    properties: {
                      currency: { type: "string", enum: CURRENCIES },
                      amount: { type: "number" },
                    },
                    required: ["currency", "amount"],
                    additionalProperties: false,
                  },
                },
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
      name: "set_account_parent",
      description:
        "Asocia una tarjeta de crédito (o cobacha) que YA EXISTE a su cuenta madre existente (banco, billetera): \"la visa es del Francés\", \"poné las tarjetas dentro del Galicia\". Se aplica en el momento, sin botones. Para varias tarjetas, llamala una vez por cada una.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "id de la tarjeta o cobacha" },
          parentId: { type: "string", description: "id de la cuenta madre (banco, billetera…)" },
        },
        required: ["accountId", "parentId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "register_card_statement",
      description:
        "Registra los datos leídos de un resumen de tarjeta de crédito (PDF o foto). El usuario lo confirma con botones antes de guardarlo. Guarda cierres y vencimientos reales y el detalle de líneas. Si el usuario elige 'Guardar todo', además carga cada consumo, cuota, suscripción, impuesto y reintegro como movimiento de la tarjeta (sin repetir lo ya cargado) y da de alta las suscripciones como gastos fijos.",
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
          last4: {
            type: "string",
            description:
              "Últimos 4 dígitos de la tarjeta, si figuran en el resumen (pasalos siempre: el sistema elige la tarjeta del usuario que termina igual).",
          },
          cardConfirmedByUser: {
            type: "boolean",
            description:
              "true solo si el usuario te dijo explícitamente a qué tarjeta va este resumen (ej. después de que el sistema te avisó que la terminación no coincide). Si no, omitir.",
          },
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
                categoryId: {
                  type: "string",
                  description:
                    "id de una categoría de GASTO para este renglón (compras, cuotas, suscripciones; en reintegros, la del gasto que devuelven). Usá las preferencias del usuario si el comercio figura ahí. Omitir en pagos.",
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
        "Cambio de moneda extranjera contra pesos: vender dólares (\"vendí 500 USD a 1480\"), comprar (\"compré 200 dólares\"), o lo mismo con euros, libras, reales, etc. (\"vendí 100 euros\"), en un banco, una billetera o con una persona (\"le cambié 300 dólares a mi señora\"). Para comprar o vender una moneda tiene que tener una cuenta en esa moneda. Si el usuario no dice a cuánto, se usa la cotización oficial del BCRA de esa moneda. Por defecto en la cuenta principal (puede ser la misma cuenta: salen dólares y entran pesos; o distintas: salen del Galicia y entran en Mercado Pago). Se confirma con botones.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["sell", "buy"], description: "sell = vende la moneda extranjera y recibe pesos; buy = paga pesos y recibe la moneda" },
          currency: {
            type: "string",
            enum: CURRENCIES.filter((c) => c !== "ARS"),
            description: "Moneda extranjera (por defecto USD)",
          },
          amount: { type: "number", description: "Cantidad de moneda extranjera" },
          rate: { type: "number", description: "Pesos por unidad, si el usuario lo dijo" },
          arsAmount: {
            type: "number",
            description:
              "Pesos totales que realmente recibió/pagó, si los dijo. Si dijo cotización Y pesos, pasá los dos: la diferencia (redondeo, comisión) queda registrada",
          },
          fromAccountId: { type: "string", description: "Cuenta de donde sale la plata (opcional)" },
          toAccountId: { type: "string", description: "Cuenta a donde entra (opcional; puede ser la misma)" },
          withWhom: {
            type: "string",
            description: 'Dónde o con quién cambió, si lo dijo (ej. "Mercado Pago", "Mi señora", "Juan", "Cueva")',
          },
          date: { type: "string", description: "YYYY-MM-DD, por defecto hoy" },
        },
        required: ["operation", "amount"],
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
        "Mover plata entre cuentas propias en la MISMA moneda: \"pasé 100 lucas del Galicia a Mercado Pago\", \"pasé 1000 dólares del Galicia a MP\" (si el destino no tenía esa moneda, se le agrega), guardar en una cobacha (\"guardé 50 lucas en la cobacha Vacaciones\") o sacar de una (\"saqué 20 lucas de la reserva\"). No es gasto ni ingreso. Para cambiar de moneda usá propose_exchange; para pagar una tarjeta, propose_card_payment. Se confirma con botones.",
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
          currency: { type: "string", enum: CURRENCIES },
          date: { type: "string", description: "YYYY-MM-DD, por defecto hoy" },
          person: {
            type: "string",
            description:
              'Con una persona (de Personas): "Orne me pasó 20 lucas a MP" → person + toAccountId; "le pasé/presté a Juan" → person + fromAccountId',
          },
          newName: { type: "string", description: "Alguien SIN la app que no está en Personas (se agrega)" },
          loan: { type: "boolean", description: "true si es un préstamo (le presté)" },
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
        "Ingreso o gasto FIJO que se repite todos los meses (\"cobro 1500000 de sueldo todos los 5\", \"pago 450 lucas de alquiler el 10\", o en dólares: \"cobro 2500 USD el 5\"). Queda en Fijos. Se confirma con botones.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["income", "expense"] },
          name: { type: "string", description: 'Nombre, ej. "Sueldo", "Alquiler"' },
          amount: { type: "number" },
          currency: { type: "string", enum: CURRENCIES },
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
        "Fija o ajusta el SALDO de una cuenta existente (no tarjeta), sin que cuente como ingreso ni gasto: \"tengo 46100 pesos y 172 dólares en el Galicia\", \"tengo 300 euros en la cuenta Euros\", \"agregale 46100 de saldo a la caja de ahorro\", \"corregí el saldo del efectivo a 20000\". Se aplica en el momento. Si la cuenta no tenía esa moneda, se la agrega.",
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
          amounts: {
            type: "array",
            description: 'Monto por moneda, ej. [{currency:"ARS",amount:46100},{currency:"USD",amount:172}]',
            items: {
              type: "object",
              properties: {
                currency: { type: "string", enum: CURRENCIES },
                amount: { type: "number" },
              },
              required: ["currency", "amount"],
              additionalProperties: false,
            },
          },
        },
        required: ["accountId", "mode", "amounts"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_share_code",
      description:
        "COMPARTE una o varias cuentas propias con otra persona (\"quiero compartir la Visa con mi señora\", \"compartí las dos tarjetas con mi marido\"). El sistema le manda al usuario, aparte, UN mensaje listo para reenviar: la otra persona se lo reenvía a su agente (o entra al link) y queda conectada a TODAS esas cuentas. Si son varias cuentas, una sola llamada con todos los ids.",
      parameters: {
        type: "object",
        properties: {
          accountIds: {
            type: "array",
            items: { type: "string" },
            description: "ids de las cuentas propias a compartir (todas juntas en un solo código)",
          },
          withWhom: { type: "string", description: 'Con quién (ej. "mi señora", "Orne")' },
        },
        required: ["accountIds"],
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
        "Consulta una cuenta que OTRA persona compartió con el usuario: gastos del mes, y si es tarjeta, cuánto se paga y cuándo vence. Solo de esa cuenta. Respeta lo que el dueño le permite ver: si visibility es \"own\", solo ve lo que cargó él (decíselo si pregunta por el total).",
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
      description:
        "Cotizaciones oficiales del BCRA (de hoy o de una fecha) de todas las monedas que publica: dólar, euro, real, libra, peso uruguayo/chileno, yen, etc. Devuelve pesos por unidad (rate) y dólares por unidad (usdPerUnit). \"El dólar\" a secas es USD oficial. Pasá currencies para pedir solo algunas; sin currencies, trae todas.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD (opcional)" },
          currencies: {
            type: "array",
            items: { type: "string" },
            description:
              'Códigos del BCRA (opcional), ej. ["EUR","BRL"]. USD dólar, EUR euro, GBP libra, BRL real, UYU peso uruguayo, CLP peso chileno, PYG guaraní, MXP peso mexicano, JPY yen, CHF franco suizo, CAD dólar canadiense',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_spending_summary",
      description:
        "Totales de un mes: ingresos, gastos, balance, gastos por categoría y por cuenta, y los cambios de dólares del mes (cuánto vendió/compró y a qué cotización promedio). Se puede filtrar por categoría o por cuenta.",
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
      description:
        "Últimos movimientos YA GUARDADOS, del más nuevo al más viejo. Es la fuente de verdad para saber si algo quedó guardado. shownInMonth es el mes en que aparece en la app (con tarjeta, el del vencimiento del resumen: dueDate).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Cuántos traer (1-20, por defecto 5)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_debts",
      description: 'Cuánto le debe cada persona al usuario y cuánto debe él ("¿cuánto me debe Orne?", "¿a quién le tengo que cobrar?").',
      parameters: {
        type: "object",
        properties: { person: { type: "string", description: "person de Personas (opcional)" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "split_always",
      description:
        'Dividir SIEMPRE un gasto que se repite (ya cargado antes): "el seguro dividilo siempre a medias con Orne", o dejar de hacerlo ("dejá de dividir Claro"). Se aplica a lo cargado desde este mes y a todo lo que entre de ahí en más.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "remove"] },
          merchant: { type: "string", description: 'Comercio/servicio como figura en sus gastos ("Federación Patronal", "Claro")' },
          people: {
            type: "array",
            description: "set: con quién y cuánto",
            items: {
              type: "object",
              properties: {
                person: { type: "string" },
                newName: { type: "string" },
                percent: { type: "number" },
                amount: { type: "number" },
              },
              additionalProperties: false,
            },
          },
          mode: { type: "string", enum: ["installments", "lump"] },
        },
        required: ["action", "merchant"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "respond_pending",
      description:
        'Responde algo de "Para responder": una conexión, un gasto que le asignaron (split) o una transferencia que registró otra persona.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["connection", "split", "transfer"] },
          accept: { type: "boolean" },
          accountId: { type: "string", description: "transfer: su cuenta donde entró/salió la plata" },
          addToBooks: { type: "boolean", description: "split: sumarlo a sus gastos (default true)" },
          categoryId: { type: "string", description: "split: categoría de gasto si lo suma" },
          always: { type: "boolean", description: 'split: "aceptá siempre" (los próximos de ese gasto se aceptan solos)' },
          reason: { type: "string", description: "Si rechaza, por qué" },
        },
        required: ["id", "type", "accept"],
        additionalProperties: false,
      },
    },
  },
  ...AGENDA_TOOLS,
  ...WEATHER_TOOLS,
  ...WATCH_TOOLS,
  ...LISTS_TOOLS,
  ...VAQUITA_TOOLS,
  ...CONTACTS_TOOLS,
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
  currency: z.enum(CURRENCIES).optional(),
  description: z.string().trim().min(1).max(200),
  accountId: z.string().min(1),
  categoryId: optStr,
  newCategoryName: optStr,
  newCategoryIcon: optStr,
  date: z.string().refine(isYMD, "date debe ser YYYY-MM-DD"),
  installments: z.number().int().min(1).max(36).optional(),
  cardClosedAtPurchase: z.boolean().optional(),
  split: z
    .object({
      people: z
        .array(
          z.object({
            person: optStr,
            newName: z.string().trim().max(60).optional(),
            percent: z.number().positive().max(100).optional(),
            amount: z.number().positive().optional(),
          }),
        )
        .min(1)
        .max(10),
      mode: z.enum(["installments", "lump"]).optional(),
      always: z.boolean().optional(),
    })
    .optional(),
  listItem: z.object({ list: z.string().trim().min(1), item: z.string().trim().min(1) }).optional(),
});

const accountItemSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(ACCOUNT_TYPES),
  closingDay: z.number().int().min(1).max(31).optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  parentId: optStr,
  parentName: optStr,
  last4: optStr.refine((v) => !v || /^\d{4}$/.test(v), "last4 debe tener 4 dígitos"),
  currencies: z.array(z.enum(CURRENCIES)).optional(),
  isMain: z.boolean().optional(),
  opening: z.array(z.object({ currency: z.enum(CURRENCIES), amount: z.number() })).max(10).optional(),
});

const categorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(["expense", "income"]),
  icon: optStr,
});

const exchangeSchema = z.object({
  // sell_usd/buy_usd: nombres viejos (por si el modelo los repite).
  operation: z
    .enum(["sell", "buy", "sell_usd", "buy_usd"])
    .transform((v) => (v.startsWith("sell") ? ("sell" as const) : ("buy" as const))),
  currency: z
    .enum(CURRENCIES)
    .optional()
    .refine((c) => c !== "ARS", "currency es la moneda extranjera (no ARS)"),
  amount: z.number().positive(),
  rate: z.number().positive().optional(),
  arsAmount: z.number().positive().optional(),
  fromAccountId: optStr,
  toAccountId: optStr,
  withWhom: z.string().trim().max(40).optional(),
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
  currency: z.enum(CURRENCIES),
  accountId: optStr,
  categoryId: optStr,
  dayOfMonth: z.number().int().min(1).max(31),
});

const fxSchema = z.object({
  date: optYMD,
  currencies: z.array(z.string().trim().min(2).max(5)).max(40).optional(),
});

const shareCodeSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1).max(10),
  withWhom: optStr,
});
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
  currency: z.enum(CURRENCIES).optional(),
  date: optYMD,
  person: optStr,
  newName: z.string().trim().max(60).optional(),
  loan: z.boolean().optional(),
});

const debtsSchema = z.object({ person: optStr });
const splitAlwaysSchema = z.object({
  action: z.enum(["set", "remove"]),
  merchant: z.string().trim().min(1).max(80),
  people: z
    .array(
      z.object({
        person: optStr,
        newName: z.string().trim().max(60).optional(),
        percent: z.number().positive().max(100).optional(),
        amount: z.number().positive().optional(),
      }),
    )
    .max(10)
    .optional(),
  mode: z.enum(["installments", "lump"]).optional(),
});
const respondPendingSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["connection", "split", "transfer"]),
  accept: z.boolean(),
  accountId: optStr,
  addToBooks: z.boolean().optional(),
  categoryId: optStr,
  reason: optStr,
  always: z.boolean().optional(),
});

/** Quién de Personas se llama así (por nombre o apodo); si hay varios, ninguno. */
const personByName = (ctx: ToolContext, q: string) => {
  const exact = ctx.people.filter((x) => personMatchScore([x.name, ...x.nicknames], q) === 2);
  return exact.length === 1 ? exact[0] : null;
};

/** Persona de la lista (o alguien nuevo sin app). */
const resolveAgentPerson = (ctx: ToolContext, person?: string, newName?: string) => {
  if (person) {
    // A veces el modelo manda el nombre o el apodo en vez del ref.
    const p = ctx.people.find((x) => x.ref === person) ?? personByName(ctx, person);
    if (!p) return { error: `"${person}" no está en Personas. Si usa la app, que se conecten desde Contactos; si no, usá newName.` };
    return { ref: p.ref as PersonRef | null, name: p.name, isApp: p.isApp, newName: null as string | null };
  }
  if (newName) {
    const same = ctx.people.find((x) => sameName(x.name, newName)) ?? personByName(ctx, newName);
    if (same) return { ref: same.ref as PersonRef | null, name: same.name, isApp: same.isApp, newName: null as string | null };
    return { ref: null, name: newName, isApp: false, newName };
  }
  return { error: "Falta la persona (person o newName)." };
};

const balanceSchema = z.object({
  accountId: z.string().min(1),
  mode: z.enum(["set", "add"]),
  amounts: z.array(z.object({ currency: z.enum(CURRENCIES), amount: z.number() })).min(1).max(10),
});

const accountParentSchema = z.object({
  accountId: z.string().min(1),
  parentId: z.string().min(1),
});

const cardDatesSchema = z.object({
  accountId: z.string().min(1),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
});

const accountsSchema = z.object({
  accounts: z.array(accountItemSchema).min(1).max(15),
});

/** "XXXX-1234" o el número entero → "1234"; menos de 4 dígitos → sin dato. */
const cleanLast4 = (v: string | undefined) => {
  const digits = v?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : undefined;
};

const statementSchema = z.object({
  accountId: optStr,
  newCardName: optStr,
  newCardParentId: optStr,
  last4: optStr.transform(cleanLast4),
  cardConfirmedByUser: z.boolean().optional(),
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
        categoryId: optStr,
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
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** Para detectar nombres repetidos: "Mercado Pago" == "MercadoPago" == "mercado-pago". */
const sameName = (a: string, b: string) =>
  normalize(a).replace(/ /g, "") === normalize(b).replace(/ /g, "");
const issues = (e: z.ZodError) => ({ error: e.issues.map((i) => i.message).join("; ") });

/** Puede ser cuenta madre: no es tarjeta ni cobacha, ni cuelga de otra. */
const canBeParent = (a: { type: string; parentId?: string | null; active?: boolean }) =>
  a.type !== "credit" && a.type !== "reserve" && !a.parentId && a.active !== false;

/**
 * Busca por nombre: exacto ("Banco Francés" == "banco frances") o, con
 * `loose`, la única que contenga o esté contenida ("Francés" ↔ "Banco Francés").
 */
const findByName = <T extends { name: string }>(pool: T[], name: string, loose: boolean) => {
  const exact = pool.find((x) => sameName(x.name, name));
  if (exact || !loose) return exact;
  const n = normalize(name).replace(/ /g, "");
  if (n.length < 4) return undefined;
  const hits = pool.filter((x) => {
    const m = normalize(x.name).replace(/ /g, "");
    return m.length >= 4 && (m.includes(n) || n.includes(m));
  });
  return hits.length === 1 ? hits[0] : undefined;
};

const BUILT_MESSAGE =
  "Borrador listo. El sistema le manda el resumen al usuario con los botones. No agregues nada más.";

// ---------- propose_transaction ----------

const proposeTransaction = async (ctx: ToolContext, raw: unknown): Promise<ToolResult> => {
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
      error: `La cuenta "${account.name}" no maneja ${currencyWords([currency])}. Usá otra cuenta o preguntale al usuario.`,
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

  // Dividirlo con otras personas.
  let split: TransactionDraft["split"] = null;
  if (args.split) {
    if (args.kind !== "expense") return { error: "Solo los gastos se pueden dividir." };
    if (sharedEntry) return { error: "Un gasto en una cuenta compartida no se puede dividir." };
    const people: NonNullable<TransactionDraft["split"]>["people"] = [];
    for (const p of args.split.people) {
      const who = resolveAgentPerson(ctx, p.person, p.newName);
      if ("error" in who) return { error: who.error };
      if (p.percent == null && p.amount == null) return { error: `Falta cuánto le toca a ${who.name} (percent o amount).` };
      people.push({
        ref: who.ref,
        newName: who.newName,
        name: who.name,
        isApp: who.isApp,
        shareType: p.percent != null ? "percent" : "amount",
        value: p.percent ?? p.amount!,
        amount: 0,
      });
    }
    const { amounts, error } = computeShares(round2(args.amount), people.map((p) => ({ shareType: p.shareType, value: p.value })));
    if (error) return { error };
    people.forEach((p, i) => (p.amount = amounts[i]));
    split = { mode: args.split.mode ?? "installments", people, always: !!args.split.always };
  }

  // Ítem de una lista: se vincula al confirmar (si no existe, se agrega en ese momento).
  let listItem: TransactionDraft["listItem"] = null;
  if (args.listItem) {
    if (args.kind !== "expense") return { error: "Solo los gastos se vinculan a un ítem de una lista." };
    const me = await loadActor(ctx.uid);
    const tree = await loadTreeFor(me);
    const r = resolveNode(tree, args.listItem.list, "list");
    if ("error" in r) return r;
    if (r.node.kind !== "list") return { error: `"${r.node.title}" es un grupo: decime en qué lista está el ítem.` };
    if (!canEdit(myRole(r.node, me))) {
      return { error: `"${r.node.title}" se la compartieron solo para ver: el gasto se puede cargar, pero no vincularlo a la lista.` };
    }
    const found = resolveItems(r.node, [args.listItem.item]);
    if (found.ambiguous.length) return { error: `Hay más de un ítem así: ${found.ambiguous.join("; ")}. Preguntale cuál.` };
    const item = found.items[0];
    listItem = {
      listId: r.node.id,
      itemId: item?.id ?? null,
      listTitle: nodePath(tree.byId, r.node),
      itemTitle: item?.title ?? args.listItem.item,
    };
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
    split,
    listItem,
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: BUILT_MESSAGE };
};

// ---------- propose_accounts ----------

/** Monedas, principal y saldo inicial de una cuenta que no es tarjeta. */
const accountMoneyFields = (a: z.infer<typeof accountItemSchema>) => {
  const opening: Partial<Record<Currency, number>> = {};
  for (const o of a.opening ?? []) if (o.amount) opening[o.currency] = round2((opening[o.currency] ?? 0) + o.amount);
  const withOpening = CURRENCIES.filter((c) => opening[c]);
  const currencies: Currency[] = a.currencies?.length
    ? [...new Set(a.currencies)]
    : withOpening.length
      ? withOpening
      : ["ARS"];
  for (const c of withOpening) if (!currencies.includes(c)) currencies.push(c);
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
    if (isCredit || isReserve) {
      // La madre puede venir como id, o como nombre de una cuenta que ya
      // existe (aunque el modelo la haya repetido en la lista) o que se crea
      // en esta misma lista.
      const pool = ctx.accounts.filter(canBeParent);
      const parent =
        (a.parentId ? pool.find((x) => x.id === a.parentId) : undefined) ??
        (a.parentName ? findByName(pool, a.parentName, false) : undefined) ??
        (a.parentId ? findByName(pool, a.parentId, false) : undefined);
      if (parent) {
        parentId = parent.id;
        parentName = parent.name;
      } else if (a.parentName || a.parentId) {
        // Se resuelve al confirmar, si esa cuenta está en la misma lista.
        parentName = a.parentName ?? a.parentId ?? null;
      }
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
            const cur: Currency = a.currencies?.[0] ?? a.opening?.find((o) => o.amount)?.currency ?? "ARS";
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

  // La cuenta madre por nombre tiene que ser otra cuenta no-crédito de la
  // lista. Si no aparece, avisamos al modelo en vez de crearla suelta.
  // Orden: exacto en la lista → parecido entre las existentes → parecido en la lista.
  const existingParents = ctx.accounts.filter(canBeParent);
  const newParents = items.filter((x) => x.accountType !== "credit" && x.accountType !== "reserve");
  const unresolved: string[] = [];
  for (const it of items) {
    if (it.parentName && !it.parentId) {
      const name = it.parentName;
      const inList = findByName(newParents, name, false);
      const existing = inList ? undefined : findByName(existingParents, name, true);
      const looseInList = inList || existing ? undefined : findByName(newParents, name, true);
      if (existing) {
        it.parentId = existing.id;
        it.parentName = existing.name;
      } else if (inList ?? looseInList) {
        it.parentName = (inList ?? looseInList)!.name;
      } else {
        unresolved.push(`"${it.name}" (de "${name}")`);
      }
    }
  }
  if (unresolved.length > 0) {
    const options = existingParents
      .map((x) => `${x.name} (id=${x.id})`)
      .join(", ");
    return {
      error: `No encontré la cuenta madre de ${unresolved.join(", ")}. Si ya existe, pasá su id en parentId (cuentas posibles: ${options || "ninguna"}); si es nueva, incluila en la misma lista; si no sabés de cuál es, preguntale.`,
    };
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

  // Tarjeta: si el resumen trae los últimos 4 y el usuario tiene una tarjeta
  // que termina igual, va a esa (como al importar desde la app), aunque el
  // modelo haya elegido otra o propuesto crearla. Si el usuario eligió la
  // tarjeta a mano, se respeta.
  let matchedBy: StatementDraft["matchedBy"] = args.cardConfirmedByUser ? "user" : null;
  if (args.last4 && !args.cardConfirmedByUser) {
    const sameEnd = ctx.accounts.filter((a) => a.type === "credit" && a.active && a.last4 === args.last4);
    const chosen = args.accountId ? ctx.accounts.find((a) => a.id === args.accountId) : undefined;
    if (sameEnd.length === 1) {
      args.accountId = sameEnd[0].id;
      args.newCardName = undefined;
      args.newCardParentId = undefined;
      matchedBy = "last4";
    } else if (sameEnd.length > 1 && !sameEnd.some((a) => a.id === args.accountId)) {
      return {
        error: `Hay varias tarjetas terminadas en ${args.last4} (${sameEnd.map((a) => a.name).join(", ")}). Preguntale al usuario cuál es y volvé a llamar con su accountId y cardConfirmedByUser: true.`,
      };
    } else if (sameEnd.length === 0 && chosen?.type === "credit" && chosen.last4 && chosen.last4 !== args.last4) {
      return {
        error: `El resumen es de una tarjeta terminada en ${args.last4} y "${chosen.name}" termina en ${chosen.last4}. Preguntale al usuario si es otra tarjeta (crearla con newCardName) o si es "${chosen.name}" con número nuevo (volvé a llamar con su accountId y cardConfirmedByUser: true).`,
      };
    }
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
    // Solo categorías de gasto (los reintegros descuentan del gasto que devuelven).
    categoryId: l.categoryId && ctx.categories.some((c) => c.id === l.categoryId && c.kind === "expense") ? l.categoryId : null,
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
  // Aunque los cargos netos den 0 o negativo (ej. una devolución de percepción),
  // cada renglón se carga con esta categoría.
  if (lines.some((l) => CHARGE_TYPES.has(l.type))) {
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
    matchedBy,
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
    cardConfirmedByUser: current.matchedBy === "user" ? true : undefined,
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
      categoryId: l.categoryId ?? undefined,
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
  // Si el usuario corrigió la tarjeta, manda su elección (no la terminación).
  if (patch.accountId || patch.newCardName) base.cardConfirmedByUser = true;

  return registerStatement(ctx, { ...base, ...patch });
};

// ---------- helpers de cuentas ----------

const mainAccount = (ctx: ToolContext) =>
  ctx.accounts.find((a) => a.isMain && a.active && a.type !== "credit");

const currencyWords = (cs: Currency[]) =>
  cs.map((c) => CURRENCY_META[c].plural.toLowerCase()).join(" y ");

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
  const foreign: Currency = args.currency ?? "USD";
  const fromCurrency: Currency = args.operation === "sell" ? foreign : "ARS";
  const toCurrency: Currency = args.operation === "sell" ? "ARS" : foreign;
  // Para comprar o vender una moneda hay que tener una cuenta en esa moneda.
  if (!ctx.accounts.some((a) => a.active && a.type !== "credit" && a.currencies.includes(foreign))) {
    return {
      error: `No tiene ninguna cuenta en ${currencyWords([foreign])}. Para ${args.operation === "sell" ? "vender" : "comprar"} ${currencyWords([foreign])} primero tiene que crear una cuenta en esa moneda (ofrecé crearla con propose_accounts).`,
    };
  }

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
  if (!rate && args.arsAmount) rate = args.arsAmount / args.amount;
  if (!rate) {
    try {
      const fx = await getRate(CURRENCY_META[foreign].bcraCode ?? foreign, args.date ?? todayYMD());
      rate = fx.rate;
      rateSource = "BCRA";
      rateDate = fx.date;
    } catch {
      return { error: "No pude consultar la cotización del BCRA. Pedile al usuario a cuánto cambió." };
    }
  }
  const ars = round2(args.arsAmount ?? args.amount * rate);
  const fAmount = round2(args.amount);
  // Dijo la cotización Y los pesos que le entraron/pagó y no cierran (redondeo,
  // comisión): se registra lo que se movió y la diferencia contra la pactada.
  const exchangeDiff =
    args.rate && args.arsAmount
      ? exchangeDiffOf(args.operation, fAmount, args.rate, ars)
      : 0;
  if (exchangeDiff !== 0) rate = ars / fAmount;
  const fromAmount = fromCurrency === "ARS" ? ars : fAmount;
  const toAmount = toCurrency === "ARS" ? ars : fAmount;

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
    ...(exchangeDiff !== 0 ? { quotedRate: args.rate, exchangeDiff } : {}),
    rateSource,
    rateDate,
    withWhom: args.withWhom || null,
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

  // Con una persona: le pasé / me pasó / le presté.
  if (args.person || args.newName) {
    const who = resolveAgentPerson(ctx, args.person, args.newName);
    if ("error" in who) return { error: who.error };
    if (args.fromAccountId && args.toAccountId) return { error: "Con una persona va una sola cuenta: la tuya (fromAccountId si salió, toAccountId si entró)." };
    const direction: "in" | "out" = args.toAccountId ? "in" : "out";
    const accountId = args.toAccountId ?? args.fromAccountId;
    const account = byId(accountId) ?? (accountId ? undefined : ctx.accounts.find((a) => a.isMain && a.active));
    if (!account) return { error: accountId ? "Esa cuenta no existe." : "¿De qué cuenta salió o a cuál entró? Preguntale." };
    if (account.type === "credit") return { error: "Con una persona va una cuenta, no una tarjeta." };
    const currency: Currency = args.currency ?? (account.currencies.length === 1 ? account.currencies[0] : "ARS");
    const draft: PersonTransferDraft = {
      type: "person-transfer",
      id: newId(),
      ref: who.ref,
      newName: who.newName,
      personName: who.name,
      isApp: who.isApp,
      direction,
      kind: args.loan ? "loan" : "payment",
      accountId: account.id,
      accountName: account.name,
      amount: round2(args.amount),
      currency,
      date: args.date ?? todayYMD(),
      createdAt: Date.now(),
    };
    ctx.proposedDraft = draft;
    return { ok: true, message: BUILT_MESSAGE };
  }

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
  const currency: Currency | undefined =
    args.currency ??
    (shared.length === 1 ? shared[0] : shared.includes("ARS") ? "ARS" : from.currencies.length === 1 ? from.currencies[0] : undefined);
  if (!currency) return { error: "No queda claro si son pesos o dólares: preguntale." };
  if (!from.currencies.includes(currency)) {
    return {
      error: `"${from.name}" no maneja ${currencyWords([currency])}. Si es un cambio de pesos a dólares (o al revés), usá propose_exchange.`,
    };
  }
  // Destino sin esa moneda (ej. Mercado Pago solo con pesos y le pasa dólares):
  // se le agrega al confirmar. Las cobachas son de una sola moneda.
  const addCurrencyToDestination = !to.currencies.includes(currency);
  if (addCurrencyToDestination && to.type === "reserve") {
    return { error: `La cobacha "${to.name}" no maneja ${currencyWords([currency])}.` };
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
    ...(addCurrencyToDestination ? { addCurrencyToDestination: true } : {}),
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

  if (AGENDA_TOOL_NAMES.has(name)) return runAgendaTool(ctx.uid, name, args);
  if (WEATHER_TOOL_NAMES.has(name)) return runWeatherTool(ctx.uid, name, args);
  if (WATCH_TOOL_NAMES.has(name)) return runWatchTool(ctx.uid, name, args);
  if (LISTS_TOOL_NAMES.has(name)) return runListsTool(ctx.uid, name, args);
  if (VAQUITA_TOOL_NAMES.has(name)) return runVaquitaTool(ctx, name, args);
  if (CONTACTS_TOOL_NAMES.has(name)) return runContactsTool(ctx, name, args);

  switch (name) {
    case "propose_transaction":
      return proposeTransaction(ctx, args);

    case "propose_expense_batch":
      return proposeBatch(ctx, args);

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

    case "set_account_parent": {
      const parsed = accountParentSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const account = resolveAccount(ctx, parsed.data.accountId);
      if (!account) return { error: "Cuenta inexistente" };
      if (account.type !== "credit" && account.type !== "reserve") {
        return { error: `"${account.name}" no es una tarjeta ni una cobacha: no puede ir dentro de otra cuenta` };
      }
      const parent = ctx.accounts.find((x) => x.id === parsed.data.parentId);
      if (!parent || parent.id === account.id || !canBeParent(parent)) {
        return { error: "Esa cuenta madre no sirve: tiene que ser un banco, billetera, efectivo… (no una tarjeta ni una cobacha)" };
      }
      if (account.parentId === parent.id) {
        return { ok: true, alreadyLinked: true, account: account.name, parent: parent.name };
      }
      await setAccountParentAdmin(ctx.uid, account.id, parent.id);
      account.parentId = parent.id;
      return { ok: true, account: account.name, parent: parent.name };
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
      const { accountId, mode } = parsed.data;
      const account = resolveAccount(ctx, accountId);
      if (!account) return { error: "Cuenta inexistente" };
      if (account.type === "credit") {
        return { error: "Las tarjetas no tienen saldo: lo que se debe sale de los gastos y pagos." };
      }
      // Mismo objeto que ctx.balances: si hay otra llamada en esta vuelta, ve el saldo ya ajustado.
      const entry = ctx.balances.accounts.find((a) => a.id === account.id);
      const current = entry?.amounts ?? zeroMoney();
      const amounts: Partial<Record<Currency, number>> = {};
      for (const a of parsed.data.amounts) amounts[a.currency] = a.amount;
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
      const ids = [...new Set(parsed.data.accountIds)];
      const accounts = ids.map((id) => ctx.accounts.find((a) => a.id === id && a.active));
      if (accounts.some((a) => !a)) return { error: "Alguna de esas cuentas no existe (o no es tuya)." };
      const valid = accounts as ServerAccountInfo[];
      if (valid.some((a) => a.type === "reserve")) {
        return { error: "Las cobachas no se comparten; compartí la cuenta madre." };
      }
      const { message } = await createShareCode(ctx.uid, valid);
      ctx.outbox.push(message);
      const who = parsed.data.withWhom;
      return {
        ok: true,
        accounts: valid.map((a) => a.name),
        note: `El sistema ya le manda al usuario, justo después de tu respuesta, el mensaje para reenviar (con el código y el link). Respondé SOLO una línea corta del estilo "Listo 👇 Reenviale el mensaje de abajo${who ? ` a ${who}` : ""}." NO escribas el código, ni instrucciones, ni cuánto dura.`,
      };
    }

    case "join_shared_account": {
      const parsed = joinSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const r = await joinWithCode(ctx.uid, parsed.data.code);
      if (!r.ok) return { error: REDEEM_ERRORS[r.reason] };
      return {
        ok: true,
        owner: r.ownerName,
        joined: r.joined.map((s) => ({ account: s.accountName, shareId: s.shareId })),
        alreadyHad: r.alreadyHad.map((s) => ({ account: s.accountName, shareId: s.shareId })),
        note: "Contale en una o dos líneas que ya puede cargar gastos en esas cuentas (entran directo a la cuenta del dueño y le avisa) y consultarlas.",
      };
    }

    case "get_shared_account_summary": {
      const parsed = sharedSummarySchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const entry = ctx.sharedWithMe.find((s) => s.shareId === parsed.data.shareId);
      if (!entry) return { error: "Esa cuenta compartida no está disponible." };
      const month = parsed.data.month ?? currentMonthKey();
      // El dueño decide qué ve: por defecto, solo lo que cargó el usuario.
      const view = await loadSharedMovements(ctx.uid, entry.shareId, month).catch(() => null);
      if (!view) return { error: "Esa cuenta compartida no está disponible." };
      if (view.visibility === "own") {
        return {
          account: entry.account.name,
          owner: entry.ownerName,
          month,
          visibility: "own",
          note: `${entry.ownerName} solo te deja ver lo que cargaste vos en esta cuenta.`,
          myTotal: view.mineTotal,
          myItems: view.items.slice(0, 30).map((i) => ({
            description: i.description,
            amount: i.credit || i.kind === "income" ? -i.amount : i.amount,
            currency: i.currency,
            installment: i.installment,
            date: i.date.slice(0, 10),
          })),
        };
      }
      if (entry.account.type === "credit") {
        const st = await getCardStatement(entry.ownerUid, entry.account, month);
        return { account: entry.account.name, owner: entry.ownerName, ...st, dueDate: formatShortDateAR(st.dueDate) };
      }
      const fx = await tryGetAppRates();
      const summary = await getMonthSummary(entry.ownerUid, month, { accountId: entry.accountId }, fx?.rates ?? null);
      return {
        account: entry.account.name,
        owner: entry.ownerName,
        month,
        expenses: Object.fromEntries(
          Object.entries(summary.byCurrency).map(([c, v]) => [c, v.expense]),
        ),
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
      if (other) {
        await notify(other, {
          kind: "share-stopped",
          title: `${me} dejó de compartir ${r.share.accountName}`,
          body: "Ya no van a ver ni cargar movimientos en esa cuenta.",
          url: "/compartidas",
          whatsappText: `🔒 ${me} dejó de compartir la cuenta *${r.share.accountName}*.`,
        });
      }
      return { ok: true, account: r.share.accountName };
    }


    case "get_balances": {
      const fx = await tryGetAppRates();
      const b = ctx.balances;
      // Solo las monedas con algo (o las que maneja la cuenta), para no llenar de ceros.
      const pick = (m: Partial<Record<Currency, number>>, keep: Currency[] = ["ARS"]) =>
        Object.fromEntries(
          CURRENCIES.filter((c) => keep.includes(c) || nonZeroCurrencies(m).includes(c)).map((c) => [c, m[c] ?? 0]),
        );
      const used = nonZeroCurrencies(b.available).filter((c) => c !== "ARS");
      const missing = used.filter((c) => !fx?.rates[c]);
      return {
        accounts: b.accounts.map((a) => ({
          name: a.name,
          kind: a.type === "credit" ? "tarjeta (lo que se debe)" : a.isMain ? "cuenta principal" : "cuenta",
          ...pick(a.amounts, ctx.accounts.find((x) => x.id === a.id)?.currencies),
        })),
        available: pick(b.available),
        cardDebt: pick(b.cardDebt),
        rates: fx
          ? {
              date: fx.date,
              source: "BCRA oficial",
              pesosPerUnit: Object.fromEntries(used.filter((c) => fx.rates[c]).map((c) => [c, fx.rates[c]])),
            }
          : null,
        availableInARS: fx && missing.length === 0 ? sumInARS(b.available, fx.rates) : null,
      };
    }

    case "get_fx_rate": {
      const parsed = fxSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      try {
        const fx = await getRates(parsed.data.date);
        const wanted = parsed.data.currencies?.map((c) => c.toUpperCase());
        // MXN es el código ISO; el BCRA usa MXP.
        const codes = wanted?.map((c) => (c === "MXN" ? "MXP" : c));
        const rates = codes ? fx.rates.filter((r) => codes.includes(r.code)) : fx.rates;
        const missing = codes?.filter((c) => !fx.rates.some((r) => r.code === c)) ?? [];
        return {
          date: fx.date,
          source: "BCRA (cotización oficial de referencia)",
          rates,
          ...(missing.length ? { notPublished: missing } : {}),
        };
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
      const fx = await tryGetAppRates();
      const summary = await getMonthSummary(
        ctx.uid,
        month ?? currentMonthKey(),
        { categoryId, accountId },
        fx?.rates ?? null,
      );
      return {
        ...summary,
        note: "byCurrency: totales en cada moneda. byCategoryARS/byAccountARS: en pesos, con las otras monedas convertidas a la cotización BCRA (ratesUsed, pesos por unidad). exchanges.byCurrency: por moneda, cuánto vendió/compró, pesos recibidos/pagados y cotización promedio (los cambios no son ingresos ni gastos).",
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

    case "get_debts": {
      const parsed = debtsSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const { splits, transfers } = await loadPeopleContext(ctx.uid);
      const ledger = computePeopleLedger({ me: ctx.uid, splits, transfers, nowMonth: currentMonthKey() });
      const rows = [...ledger.values()]
        .filter((l) => !parsed.data.person || l.ref === parsed.data.person)
        .map((l) => ({
          person: l.ref,
          name: l.name,
          usesApp: l.isApp,
          // + = te debe; − = le debés. due = vencido; upcoming = cuotas que vienen.
          ...Object.fromEntries(
            CURRENCIES.filter((c) => c === "ARS" || ledgerTotal(l, c) || l.due[c] || l.upcoming[c]).map((c) => [
              c,
              { total: ledgerTotal(l, c), due: l.due[c], upcoming: l.upcoming[c] },
            ]),
          ),
          last: l.entries.slice(0, 5).map((e) => ({ date: e.date, what: e.description, amount: e.amount, currency: e.currency })),
        }));
      return {
        people: rows,
        pending: ctx.pending,
        note: "Montos positivos: esa persona le debe al usuario; negativos: el usuario le debe. Sin monedas mezcladas.",
      };
    }

    case "split_always": {
      const parsed = splitAlwaysSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const a = parsed.data;
      const key = normalizeMerchant(a.merchant);
      const rules = await loadSplitRules(ctx.uid);
      if (a.action === "remove") {
        const rule = rules.find((r) => r.key === key || sameName(r.label, a.merchant) || normalize(r.label).includes(normalize(a.merchant)));
        if (!rule) return { error: `«${a.merchant}» no se divide siempre. Se dividen siempre: ${rules.map((r) => r.label).join(", ") || "nada"}.` };
        await deleteSplitRule(ctx.uid, rule.id);
        return { ok: true, message: `Listo: «${rule.label}» ya no se divide solo (lo ya dividido queda).` };
      }
      if (!a.people?.length) return { error: "Falta con quién y cuánto (people)." };
      // Un gasto de ese comercio (el más reciente) para reconocerlo y validar las partes.
      const txs = await adminDb().collection(`users/${ctx.uid}/transactions`).where("kind", "==", "expense").get();
      const sample = txs.docs
        .map((d) => ({ id: d.id, ...(d.data() as { description?: string; purchaseDate?: { toMillis(): number } }) }))
        .filter((t) => {
          const k = normalizeMerchant(String(t.description ?? ""));
          return k === key || (key.length >= 4 && (k.includes(key) || key.includes(k)) && k.length >= 4);
        })
        .sort((x, y) => (y.purchaseDate?.toMillis() ?? 0) - (x.purchaseDate?.toMillis() ?? 0))[0];
      if (!sample) {
        return { error: `No encontré gastos de «${a.merchant}». Cuando lo cargue, dividilo con split y always: true.` };
      }
      const participants = [];
      for (const p of a.people) {
        const who = resolveAgentPerson(ctx, p.person, p.newName);
        if ("error" in who) return { error: who.error };
        if (p.percent == null && p.amount == null) return { error: `Falta cuánto le toca a ${who.name}.` };
        participants.push({
          ref: who.ref ?? (await ensureOfflineContact(ctx.uid, who.newName ?? who.name)),
          shareType: (p.percent != null ? "percent" : "amount") as "percent" | "amount",
          value: p.percent ?? p.amount!,
        });
      }
      try {
        const r = await createSplitRule(ctx.uid, { txId: sample.id, mode: a.mode ?? "installments", participants });
        return {
          ok: true,
          label: r.label,
          dividedNow: r.applied,
          message: `Desde ahora «${r.label}» se divide solo${r.applied ? `; ya dividí ${r.applied} cargado${r.applied === 1 ? "" : "s"} desde este mes` : ""}. A los que usan la app les llega para aceptar.`,
        };
      } catch (err) {
        if (err instanceof PeopleError) return { error: err.message };
        throw err;
      }
    }

    case "respond_pending": {
      const parsed = respondPendingSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const a = parsed.data;
      try {
        if (a.type === "connection") {
          await respondConnection({ uid: ctx.uid }, a.id, a.accept);
          return { ok: true, message: a.accept ? "Conectados." : "Solicitud rechazada." };
        }
        if (a.type === "split") {
          const addToBooks = a.accept && a.addToBooks !== false;
          if (addToBooks) {
            const cat = ctx.categories.find((c) => c.id === a.categoryId && c.kind === "expense");
            if (!cat) return { error: "Para sumarlo a sus gastos hace falta categoryId (de gasto). Elegí la más parecida." };
          }
          await respondSplit({ uid: ctx.uid }, a.id, {
            accept: a.accept,
            addToBooks,
            categoryId: addToBooks ? a.categoryId : null,
            reason: a.reason ?? null,
            always: !!a.always,
          });
          return {
            ok: true,
            message: a.accept
              ? `${addToBooks ? "Aceptado y sumado a sus gastos." : "Aceptado."}${a.always ? " Los próximos de ese gasto se aceptan solos (si se divide siempre)." : ""}`
              : "Rechazado; le avisamos.",
          };
        }
        let accountId = a.accountId;
        if (a.accept && !accountId) {
          const main = ctx.accounts.find((x) => x.isMain && x.active && x.type !== "credit");
          if (!main) return { error: "¿En qué cuenta entró (o de cuál salió)? Preguntale." };
          accountId = main.id;
        }
        await respondPersonTransfer({ uid: ctx.uid }, a.id, { accept: a.accept, accountId: accountId ?? null });
        return { ok: true, message: a.accept ? "Transferencia confirmada." : "Le avisamos que no la reconoce." };
      } catch (err) {
        if (err instanceof PeopleError) return { error: err.message };
        throw err;
      }
    }

    case "list_recent_transactions": {
      const parsed = recentSchema.safeParse(args);
      if (!parsed.success) return issues(parsed.error);
      const list = await listRecentTransactions(ctx.uid, parsed.data.limit ?? 5);
      return {
        transactions: list.map((t) => ({
          ...t,
          date: formatShortDateAR(t.date),
          ...(t.dueDate ? { dueDate: formatShortDateAR(t.dueDate) } : {}),
        })),
      };
    }

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
};
