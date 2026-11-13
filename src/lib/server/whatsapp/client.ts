import "server-only";

/**
 * Cliente mínimo de la WhatsApp Cloud API (Graph API de Meta).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v24.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

const getConfig = () => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error(
      "WhatsApp no está configurado. Cargá WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID.",
    );
  }
  return { token, phoneNumberId };
};

/**
 * Números de Argentina: el webhook los manda como 549XXXXXXXXXX, pero la
 * lista de destinatarios permitidos de Meta los guarda sin el 9
 * (54XXXXXXXXXX) y mandar al 549… falla con el error 131030. Por defecto
 * sacamos el 9; se puede desactivar con WHATSAPP_AR_STRIP_9=false.
 */
export const toSendableNumber = (waId: string): string => {
  const strip = process.env.WHATSAPP_AR_STRIP_9 !== "false";
  if (strip && waId.startsWith("549") && waId.length === 13) {
    return `54${waId.slice(3)}`;
  }
  return waId;
};

const postMessage = async (payload: Record<string, unknown>) => {
  const { token, phoneNumberId } = getConfig();
  const res = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${text}`);
  }
  return res.json() as Promise<unknown>;
};

// WhatsApp corta los textos en 4096 caracteres.
const MAX_TEXT = 4000;

export const sendText = async (to: string, body: string) =>
  postMessage({
    recipient_type: "individual",
    to: toSendableNumber(to),
    type: "text",
    text: { body: body.slice(0, MAX_TEXT), preview_url: false },
  });

export interface ReplyButton {
  id: string;
  /** Máximo 20 caracteres. */
  title: string;
}

/** Mensaje interactivo con hasta 3 botones de respuesta rápida. */
export const sendButtons = async (
  to: string,
  body: string,
  buttons: ReplyButton[],
) =>
  postMessage({
    recipient_type: "individual",
    to: toSendableNumber(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
        })),
      },
    },
  });

/** Marca el mensaje como leído y muestra "escribiendo…" mientras procesamos. */
export const markAsReadWithTyping = async (messageId: string) =>
  postMessage({
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
}

/** Descarga un archivo (audio, imagen) recibido por WhatsApp. */
export const downloadMedia = async (mediaId: string): Promise<DownloadedMedia> => {
  const { token } = getConfig();
  const metaRes = await fetch(`${GRAPH_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media ${metaRes.status}: ${await metaRes.text()}`);
  }
  const meta = (await metaRes.json()) as { url: string; mime_type: string };
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) {
    throw new Error(`WhatsApp media download ${fileRes.status}`);
  }
  return {
    data: Buffer.from(await fileRes.arrayBuffer()),
    mimeType: meta.mime_type,
  };
};
