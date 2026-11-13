import { after } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/firebase-admin";
import { isValidSignature } from "@/lib/server/whatsapp/signature";
import { handleIncomingMessage } from "@/lib/server/whatsapp/handle-message";
import type {
  WaIncomingMessage,
  WaWebhookPayload,
} from "@/lib/server/whatsapp/types";

export const runtime = "nodejs";
// El procesamiento (OpenAI + Firestore) corre en after(), dentro de este límite.
// Leer un resumen de tarjeta en PDF puede tardar más de un minuto.
export const maxDuration = 300;

/** Handshake de verificación que hace Meta al configurar el webhook. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.error("[wa] falta WHATSAPP_APP_SECRET");
    return new Response("Not configured", { status: 500 });
  }

  const raw = await req.text();
  if (!isValidSignature(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: WaWebhookPayload;
  try {
    payload = JSON.parse(raw) as WaWebhookPayload;
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const incoming: Array<{ message: WaIncomingMessage; profileName: string | null }> = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      // Los "statuses" (enviado/entregado/leído) no nos interesan.
      for (const message of value?.messages ?? []) {
        const contact = value?.contacts?.find((c) => c.wa_id === message.from);
        incoming.push({ message, profileName: contact?.profile?.name ?? null });
      }
    }
  }

  // Meta reintenta si no respondemos rápido: deduplicamos por id de mensaje.
  const fresh: typeof incoming = [];
  for (const item of incoming) {
    try {
      await adminDb()
        .collection("waProcessedMessages")
        .doc(item.message.id)
        .create({ from: item.message.from, createdAt: FieldValue.serverTimestamp() });
      fresh.push(item);
    } catch {
      // Ya existía: es un reintento, lo ignoramos.
    }
  }

  if (fresh.length > 0) {
    after(async () => {
      for (const { message, profileName } of fresh) {
        await handleIncomingMessage(message, profileName);
      }
    });
  }

  return new Response("OK", { status: 200 });
}
