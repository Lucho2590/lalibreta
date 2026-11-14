import "server-only";

import OpenAI, { toFile } from "openai";
import { recordAiUsage, usageFromTranscription } from "../ai-usage";

let client: OpenAI | null = null;

export const openai = (): OpenAI => {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY");
  client = new OpenAI({ apiKey });
  return client;
};

// gpt-5.4-mini confunde tipo y nombre de cuenta y omite líneas de resúmenes;
// gpt-5.4 los resuelve bien. Para uso familiar la diferencia de costo es mínima.
export const CHAT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";
/** Modelo para fotos y PDFs (resúmenes largos). Por defecto, el mismo de chat. */
export const DOCUMENT_MODEL = process.env.OPENAI_DOCUMENT_MODEL ?? CHAT_MODEL;
export const TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe";

const extensionFor = (mime: string): string => {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("amr")) return "amr";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  return "ogg";
};

/** Transcribe una nota de voz de WhatsApp (ogg/opus normalmente). */
export const transcribeAudio = async (
  data: Buffer,
  mimeType: string,
  uid?: string,
): Promise<string> => {
  const baseMime = mimeType.split(";")[0].trim();
  const file = await toFile(data, `nota.${extensionFor(baseMime)}`, {
    type: baseMime,
  });
  const res = await openai().audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
    language: "es",
  });
  void recordAiUsage(uid, "transcribe", TRANSCRIBE_MODEL, usageFromTranscription(res.usage));
  return res.text.trim();
};
