import { authedPost } from "@/lib/server/route";
import { createVaquita, type CreateVaquitaInput } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Crear una vaquita. */
export const POST = authedPost<CreateVaquitaInput>(async (user, body) => {
  return await createVaquita(user, body);
});
