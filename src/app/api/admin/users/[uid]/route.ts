import { NextResponse } from "next/server";
import { z } from "zod";
import { adminErrorResponse, requireAdmin } from "@/lib/server/admin";
import { runAdminAction } from "@/lib/server/admin-data";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["reset-memory", "new-agent", "unlink-whatsapp"]),
  agentName: z.string().max(80).optional(),
});

/** Acciones sobre un usuario: reiniciar el agente, cambiarlo o desvincular WhatsApp. */
export async function POST(req: Request, ctx: { params: Promise<{ uid: string }> }) {
  let admin;
  try {
    admin = await requireAdmin(req);
  } catch (err) {
    const res = adminErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const { uid } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Acción inválida" }, { status: 400 });
  try {
    const r = await runAdminAction(uid, parsed.data.action, parsed.data.agentName);
    console.log("[admin]", admin.email, parsed.data.action, uid);
    return NextResponse.json(r);
  } catch (err) {
    console.error("[admin] acción falló", err);
    return NextResponse.json({ error: "No se pudo completar la acción" }, { status: 500 });
  }
}
