import { authedPost } from "@/lib/server/route";
import { deleteExpense } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Borrar un gasto de la vaquita. */
export const POST = authedPost<{ vaquitaId: string; expenseId: string }>(async (user, body) => {
  await deleteExpense(user, body);
});
