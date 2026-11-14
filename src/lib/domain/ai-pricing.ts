/**
 * Precios de OpenAI en US$ por millón de tokens (developers.openai.com/api/pricing,
 * revisado en noviembre de 2026). El costo se calcula y guarda al momento de
 * cada llamada: si cambian los precios, actualizar esta tabla (lo viejo no cambia).
 */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
  /** Solo transcripción: tokens de audio de entrada. */
  audioInput?: number;
}

export const AI_PRICES: Record<string, ModelPrice> = {
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-4o-mini-transcribe": { input: 1.25, cachedInput: 1.25, output: 5, audioInput: 3 },
  "gpt-4o-transcribe": { input: 2.5, cachedInput: 2.5, output: 10, audioInput: 6 },
};

/** Transcripción cobrada por minuto (cuando la API devuelve duración en vez de tokens). */
export const TRANSCRIBE_USD_PER_MINUTE: Record<string, number> = {
  "gpt-4o-mini-transcribe": 0.003,
  "gpt-4o-transcribe": 0.006,
  "whisper-1": 0.006,
};

/** Precio del modelo (o del más cercano por prefijo; si no se conoce, el de gpt-5.4). */
export const priceFor = (model: string): { price: ModelPrice; known: boolean } => {
  if (AI_PRICES[model]) return { price: AI_PRICES[model], known: true };
  // "gpt-5.4-2026-03-05" → "gpt-5.4"
  const base = Object.keys(AI_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  if (base) return { price: AI_PRICES[base], known: true };
  return { price: AI_PRICES["gpt-5.4"], known: false };
};

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  audioTokens?: number;
  /** Transcripción por duración. */
  audioSeconds?: number;
}

export const costOfUsage = (model: string, u: TokenUsage): number => {
  if (u.audioSeconds && !u.inputTokens && !u.outputTokens) {
    return (u.audioSeconds / 60) * (TRANSCRIBE_USD_PER_MINUTE[model] ?? 0.006);
  }
  const { price } = priceFor(model);
  const uncached = Math.max(0, u.inputTokens - u.cachedTokens - (u.audioTokens ?? 0));
  return (
    (uncached * price.input +
      u.cachedTokens * price.cachedInput +
      (u.audioTokens ?? 0) * (price.audioInput ?? price.input) +
      u.outputTokens * price.output) /
    1_000_000
  );
};

export type AiFeature = "chat" | "document" | "statement" | "transcribe";

export const AI_FEATURE_LABEL: Record<AiFeature, string> = {
  chat: "Chat de WhatsApp",
  document: "Fotos y PDFs por WhatsApp",
  statement: "Importar resúmenes (web)",
  transcribe: "Audios",
};

/** Lo que guarda cada documento `aiUsage/{YYYY-MM}_{uid}`. */
export interface AiUsageBucket {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}
