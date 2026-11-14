import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { normalizeMerchant } from "@/lib/domain/merchants";
import { splitDuplicates } from "../batch-admin";
import { loadCategoryRules } from "../statement-import";
import { isYMD, todayYMD } from "../time";
import type { ServerAccountInfo, ServerCategoryInfo } from "../queries-admin";
import type { BatchDraft, BatchDraftLine } from "../whatsapp/types";
import type { ToolContext } from "./tools";

export const MAX_BATCH_LINES = 150;

export const PROPOSE_BATCH_TOOL: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "propose_expense_batch",
    description:
      "Arma VARIOS gastos (o ingresos) juntos para que el usuario los confirme con un solo botón. Usala cuando te pasan una LISTA de movimientos: captura del home banking o de la app de la tarjeta (consumos, próximos consumos, cuotas), foto o archivo de una planilla/Excel, o una lista escrita. Incluí TODOS los renglones, sin inventar. No la uses para un resumen de tarjeta completo con cierre, vencimiento y total (eso es register_card_statement).",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description:
            "Cuenta de la lista (tarjeta, banco…) a la que van los renglones que no digan otra. Si la captura es de una tarjeta, el id de esa tarjeta.",
        },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: 'Comercio o concepto, limpio y legible ("MERPAGO*RAPPI" → "Rappi")' },
              amount: {
                type: "number",
                description: "Monto POSITIVO del renglón tal como figura. Si es una cuota (ej. 3/6), el monto de ESA cuota.",
              },
              currency: { type: "string", enum: ["ARS", "USD"] },
              kind: {
                type: "string",
                enum: ["expense", "income"],
                description: "expense por defecto; income para reintegros, devoluciones o ingresos",
              },
              date: {
                type: "string",
                description: "Fecha de la compra YYYY-MM-DD, si figura (en cuotas, la de la compra original). Omitir si no figura.",
              },
              installmentNumber: { type: "integer", description: 'Cuota actual, si dice "3/6" → 3' },
              installmentsTotal: { type: "integer", description: 'Total de cuotas, si dice "3/6" → 6' },
              categoryId: {
                type: "string",
                description:
                  "id de una categoría EXISTENTE del mismo tipo (en una tarjeta, los reintegros llevan la categoría de GASTO que devuelven). Si no sabés, omitilo (se usa la preferencia del usuario o Otros).",
              },
              accountId: { type: "string", description: "Solo si este renglón va a otra cuenta que la general" },
            },
            required: ["description", "amount", "currency"],
            additionalProperties: false,
          },
        },
      },
      required: ["accountId", "lines"],
      additionalProperties: false,
    },
  },
};

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const batchSchema = z.object({
  accountId: z.string().min(1),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        amount: z.number().refine((n) => n !== 0, "amount no puede ser 0"),
        currency: z.enum(["ARS", "USD"]),
        kind: z.enum(["expense", "income"]).optional(),
        date: optStr,
        installmentNumber: z.number().int().min(1).max(60).optional(),
        installmentsTotal: z.number().int().min(1).max(60).optional(),
        categoryId: optStr,
        accountId: optStr,
      }),
    )
    .min(1)
    .max(MAX_BATCH_LINES),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "YYYY-MM-DD" n meses antes (el día se ajusta al último del mes si hace falta). */
const monthsBefore = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
};

const fallbackCategory = (categories: ServerCategoryInfo[], kind: "expense" | "income") => {
  const pool = categories.filter((c) => c.kind === kind);
  return pool.find((c) => /^otro/i.test(c.name)) ?? pool[0];
};

export const proposeBatch = async (ctx: ToolContext, raw: unknown) => {
  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  const args = parsed.data;

  const own = (id: string): ServerAccountInfo | undefined => ctx.accounts.find((a) => a.id === id && a.active);
  if (args.accountId.startsWith("shared:") || args.lines.some((l) => l.accountId?.startsWith("shared:"))) {
    return { error: "La carga en lote es solo para cuentas propias. En una cuenta compartida cargá los gastos de a uno." };
  }
  const main = own(args.accountId);
  if (!main) return { error: "La cuenta no existe o está inactiva. Usá un id de la lista." };

  const rules = await loadCategoryRules(ctx.uid);
  const ruleByKey = new Map(rules.map((r) => [r.key, r.categoryId]));
  const catById = new Map(ctx.categories.map((c) => [c.id, c]));
  const today = todayYMD();

  const lines: BatchDraftLine[] = [];
  const problems: string[] = [];
  for (const l of args.lines) {
    const account = l.accountId ? own(l.accountId) : main;
    if (!account) {
      problems.push(`"${l.description}": la cuenta no existe`);
      continue;
    }
    if (!account.currencies.includes(l.currency)) {
      problems.push(`"${l.description}": ${account.name} no maneja ${l.currency === "USD" ? "dólares" : "pesos"}`);
      continue;
    }
    // Un monto negativo es un reintegro/devolución.
    const kind = l.kind ?? (l.amount < 0 ? "income" : "expense");
    const amount = round2(Math.abs(l.amount));

    const isCreditExpense = account.type === "credit" && kind === "expense";
    const n = isCreditExpense && (l.installmentsTotal ?? 0) > 1 ? l.installmentsTotal! : null;
    const k = n ? Math.min(Math.max(1, l.installmentNumber ?? 1), n) : null;

    // Sin fecha: hoy. Una cuota k sin fecha: la compra fue k-1 meses atrás, así
    // la cuota k cae en el resumen actual.
    const validDate = l.date && isYMD(l.date) && l.date <= today ? l.date : null;
    const date = validDate ?? (k && k > 1 ? monthsBefore(today, k - 1) : today);

    // Un reintegro en una tarjeta lleva la categoría del gasto que devuelve
    // (descuenta de ese gasto), igual que al importar un resumen.
    const catKind = account.type === "credit" ? "expense" : kind;
    const chosen = l.categoryId ? catById.get(l.categoryId) : undefined;
    const ruled = catById.get(ruleByKey.get(normalizeMerchant(l.description)) ?? "");
    const category =
      (chosen?.kind === catKind ? chosen : undefined) ??
      (ruled?.kind === catKind ? ruled : undefined) ??
      fallbackCategory(ctx.categories, catKind);
    if (!category) {
      return {
        error: `El usuario no tiene categorías de ${catKind === "expense" ? "gasto" : "ingreso"}. Creá una con create_category y volvé a armar el lote.`,
      };
    }

    lines.push({
      description: l.description,
      amount,
      currency: l.currency,
      kind,
      date,
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      categoryId: category.id,
      categoryName: category.name,
      installmentNumber: k,
      installmentsTotal: n,
    });
  }

  if (lines.length === 0) {
    return { error: `No quedó ningún renglón para cargar. ${problems.join("; ")}` };
  }

  const { fresh, duplicates } = await splitDuplicates(ctx.uid, lines);
  if (fresh.length === 0) {
    return {
      ok: true,
      allDuplicates: true,
      message: `Los ${duplicates.length} movimientos ya estaban cargados: no hay nada nuevo. Decíselo al usuario.`,
    };
  }

  const draft: BatchDraft = {
    type: "batch",
    id: randomUUID().slice(0, 8),
    lines: fresh,
    duplicates: duplicates.map((d) => ({ description: d.description, amount: d.amount, currency: d.currency })),
    skipped: problems,
    createdAt: Date.now(),
  };
  ctx.proposedDraft = draft;
  return { ok: true, message: "Borrador listo. El sistema le manda el resumen al usuario con los botones. No agregues nada más." };
};
