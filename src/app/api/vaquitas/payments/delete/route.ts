import { authedPost } from "@/lib/server/route";
import { deletePayment } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Borrar un pago. */
export const POST = authedPost<{ vaquitaId: string; paymentId: string }>(async (user, body) => {
  await deletePayment(user, body);
});
