import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, getAuthedUser, unauthorizedResponse } from "@/lib/server/auth";
import { ActivityError, updateActivityAdmin } from "@/lib/server/activities";

export const runtime = "nodejs";

const schema = z.object({
  activityId: z.string().min(1),
  input: z.object({
    title: z.string().trim().min(1).max(120),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
    location: z.string().max(120).nullish(),
    notes: z.string().max(500).nullish(),
    estimatedAmount: z.number().positive().max(1_000_000_000).nullish(),
    currency: z.enum(["ARS", "USD"]).nullish(),
  }),
  invitees: z
    .array(
      z.object({
        uid: z.string().nullish(),
        email: z.string().email(),
        displayName: z.string().nullish(),
        photoURL: z.string().nullish(),
      }),
    )
    .max(50),
});

/** El dueño cambia la actividad; se avisa a los invitados de lo que cambió. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  const { activityId, input, invitees } = parsed.data;
  try {
    const result = await updateActivityAdmin(
      user.uid,
      activityId,
      input,
      invitees.map((i) => ({ ...i, uid: i.uid ?? null })),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ActivityError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
