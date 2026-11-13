import { NextResponse } from "next/server";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { createLinkCode } from "@/lib/server/whatsapp/linking";

export const runtime = "nodejs";

/** Genera un código de 6 dígitos para vincular el WhatsApp del usuario. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const { code, expiresAt } = await createLinkCode(user.uid);
  return NextResponse.json({
    code,
    expiresAt: expiresAt.toISOString(),
    botNumber: process.env.WHATSAPP_BOT_NUMBER ?? null,
  });
}
