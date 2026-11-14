import { NextResponse } from "next/server";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { REDEEM_ERRORS, joinWithCode } from "@/lib/server/sharing";

export const runtime = "nodejs";

/** Canjea un código de cuenta compartida. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const body = (await req.json().catch(() => null)) as { code?: string } | null;
  const code = (body?.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) {
    return NextResponse.json({ error: "El código tiene 6 dígitos" }, { status: 400 });
  }

  const r = await joinWithCode(user.uid, code);
  if (!r.ok) {
    return NextResponse.json({ error: REDEEM_ERRORS[r.reason] }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    ownerName: r.ownerName,
    accounts: [...r.joined, ...r.alreadyHad].map((s) => s.accountName),
    alreadyHad: r.joined.length === 0,
  });
}
