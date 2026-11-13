import { NextResponse } from "next/server";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { getLinkForUser } from "@/lib/server/whatsapp/linking";
import { ensureAgentName } from "@/lib/server/onboarding";

export const runtime = "nodejs";

/** Número de WhatsApp vinculado al usuario (si hay). */
export async function GET(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const [link, agentName] = await Promise.all([
    getLinkForUser(user.uid),
    ensureAgentName(user.uid),
  ]);
  return NextResponse.json({
    agentName,
    linked: !!link,
    phone: link ? `+${link.waId}` : null,
    linkedAt: link?.linkedAt?.toISOString() ?? null,
    botNumber: process.env.WHATSAPP_BOT_NUMBER ?? null,
  });
}
