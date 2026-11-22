import { authedPost } from "@/lib/server/route";
import { updateVaquita, type UpdateVaquitaInput } from "@/lib/server/vaquitas";

export const runtime = "nodejs";

/** Cambiar nombre, moneda, estado (cerrar/abrir) o mi categoría. */
export const POST = authedPost<UpdateVaquitaInput>(async (user, body) => {
  await updateVaquita(user, body);
});
