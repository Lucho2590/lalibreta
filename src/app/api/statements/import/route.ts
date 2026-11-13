import { NextResponse } from "next/server";
import { z } from "zod";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { importStatement } from "@/lib/server/statement-import";
import type { ImportPayload } from "@/lib/domain/statement-import";

export const runtime = "nodejs";
export const maxDuration = 120;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lineSchema = z.object({
  index: z.number().int(),
  date: ymd.nullable(),
  description: z.string().min(1).max(200),
  amount: z.number(),
  currency: z.enum(["ARS", "USD"]),
  installmentNumber: z.number().int().min(1).max(60).nullable(),
  installmentsTotal: z.number().int().min(1).max(60).nullable(),
  type: z.enum(["purchase", "installment", "subscription", "tax", "fee", "interest", "payment", "credit", "other"]),
  merchantKey: z.string().max(120),
  suggestedCategoryId: z.string().nullable(),
  categorySource: z.enum(["rule", "ai"]).nullable(),
  duplicateOf: z.string().nullable(),
  include: z.boolean(),
  categoryId: z.string().nullable(),
});
const schema = z.object({
  account: z.union([
    z.object({ existingId: z.string().min(1) }),
    z.object({ newName: z.string().trim().min(1).max(60), parentId: z.string().nullable() }),
  ]),
  last4: z.string().regex(/^\d{4}$/).nullable(),
  closingDate: ymd,
  dueDate: ymd,
  nextClosingDate: ymd.nullable(),
  nextDueDate: ymd.nullable(),
  totalARS: z.number(),
  totalUSD: z.number(),
  minimumPayment: z.number().nullable(),
  lines: z.array(lineSchema).max(500),
});

/** Guarda el resumen, carga los consumos elegidos y aprende las categorías. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const result = await importStatement(user.uid, parsed.data as ImportPayload);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[statements/import]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "No se pudo importar" },
      { status: 500 },
    );
  }
}
