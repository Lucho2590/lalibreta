import { authedPost } from "@/lib/server/route";
import { saveExpense, type ExpenseInput } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Cargar o editar un gasto de la vaquita. */
export const POST = authedPost<ExpenseInput>(async (user, body) => {
  return await saveExpense(user, body);
});
