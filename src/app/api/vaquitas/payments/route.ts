import { authedPost } from "@/lib/server/route";
import { savePayment, type PaymentInput } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Registrar o editar un pago para saldar. */
export const POST = authedPost<PaymentInput>(async (user, body) => {
  return await savePayment(user, body);
});
