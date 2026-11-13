import { NextResponse } from "next/server";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { unlinkUser } from "@/lib/server/whatsapp/linking";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const removed = await unlinkUser(user.uid);
  return NextResponse.json({ ok: true, removed });
}
