import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { currentMonthKey } from "./time";
import { costOfUsage, type AiFeature, type TokenUsage } from "@/lib/domain/ai-pricing";

/**
 * Registra cada llamada a OpenAI: tokens y costo estimado, por usuario y mes
 * (`aiUsage/{YYYY-MM}_{uid}`, solo server). Nunca rompe la llamada original.
 */

type ChatUsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
} | null | undefined;

export const usageFromChat = (u: ChatUsageLike): TokenUsage => ({
  inputTokens: u?.prompt_tokens ?? 0,
  cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
  outputTokens: u?.completion_tokens ?? 0,
});

type TranscriptionUsageLike =
  | {
      type?: string;
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: { audio_tokens?: number; text_tokens?: number } | null;
      seconds?: number;
    }
  | null
  | undefined;

export const usageFromTranscription = (u: TranscriptionUsageLike): TokenUsage =>
  u?.type === "duration"
    ? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, audioSeconds: u.seconds ?? 0 }
    : {
        inputTokens: u?.input_tokens ?? 0,
        cachedTokens: 0,
        outputTokens: u?.output_tokens ?? 0,
        audioTokens: u?.input_token_details?.audio_tokens ?? 0,
      };

/** Las claves de mapas de Firestore no pueden tener "." en field paths: "gpt-5.4" → "gpt-5_4". */
export const modelKey = (model: string) => model.replace(/[.\/]/g, "_");

export const recordAiUsage = async (
  uid: string | null | undefined,
  feature: AiFeature,
  model: string,
  usage: TokenUsage,
): Promise<void> => {
  if (!uid) return;
  // "gpt-5.4-2026-03-05" → "gpt-5.4" (la API devuelve la versión con fecha).
  model = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  try {
    const costUsd = costOfUsage(model, usage);
    const month = currentMonthKey();
    const inc = (n: number) => FieldValue.increment(n);
    const bucket = {
      calls: inc(1),
      inputTokens: inc(usage.inputTokens),
      cachedTokens: inc(usage.cachedTokens),
      outputTokens: inc(usage.outputTokens),
      costUsd: inc(costUsd),
    };
    await adminDb()
      .collection("aiUsage")
      .doc(`${month}_${uid}`)
      .set(
        {
          uid,
          month,
          ...bucket,
          audioTokens: inc(usage.audioTokens ?? 0),
          audioSeconds: inc(usage.audioSeconds ?? 0),
          byFeature: { [feature]: bucket },
          byModel: { [modelKey(model)]: bucket },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[ai-usage] no se pudo registrar", err);
  }
};
