import "server-only";

import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { CHAT_MODEL, DOCUMENT_MODEL, openai } from "./openai";
import { recordAiUsage, usageFromChat } from "../ai-usage";
import { buildSystemPrompt, type PromptContext } from "./prompt";
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "./tools";
import type { ChatTurn, Draft } from "../whatsapp/types";

export interface AgentInput {
  text: string;
  /** data URL (data:image/jpeg;base64,...) para fotos de tickets o resúmenes. */
  imageDataUrl?: string;
  /** PDF (resúmenes de tarjeta, facturas). */
  pdf?: { filename: string; dataUrl: string };
}

export interface AgentResult {
  reply: string;
  draft: Draft | null;
}

const MAX_ROUNDS = 5;
const LEAKED_TOOL_CALL = /functions\.[a-z_]+|"(accountId|categoryId|cardId)"\s*:/;

export const runAgent = async (
  prompt: PromptContext & { uid: string },
  history: ChatTurn[],
  input: AgentInput,
): Promise<AgentResult> => {
  const ctx: ToolContext = {
    uid: prompt.uid,
    accounts: prompt.accounts,
    categories: prompt.categories,
    recurring: prompt.recurring,
    balances: prompt.balances,
    sharedWithMe: prompt.sharedWithMe,
    myShares: prompt.myShares,
    pendingDraft: prompt.pendingDraft,
    proposedDraft: null,
  };

  const userContent: ChatCompletionContentPart[] = [
    { type: "text", text: input.text || "(archivo sin texto)" },
  ];
  if (input.imageDataUrl) {
    userContent.push({
      type: "image_url",
      image_url: { url: input.imageDataUrl, detail: "high" },
    });
  }
  if (input.pdf) {
    userContent.push({
      type: "file",
      file: { filename: input.pdf.filename, file_data: input.pdf.dataUrl },
    });
  }
  const hasDocument = Boolean(input.imageDataUrl || input.pdf);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(prompt) },
    ...history.map((t) => ({ role: t.role, content: t.content }) as ChatCompletionMessageParam),
    { role: "user", content: userContent },
  ];

  let retriedLeakedToolCall = false;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const model = hasDocument ? DOCUMENT_MODEL : CHAT_MODEL;
    const completion = await openai().chat.completions.create({
      // Para leer resúmenes largos conviene un modelo más grande (configurable).
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      ...(process.env.OPENAI_REASONING_EFFORT
        ? { reasoning_effort: process.env.OPENAI_REASONING_EFFORT as "low" }
        : {}),
    });
    void recordAiUsage(prompt.uid, hasDocument ? "document" : "chat", completion.model || model, usageFromChat(completion.usage));
    const msg = completion.choices[0]?.message;
    if (!msg) break;

    const toolCalls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (toolCalls.length === 0) {
      const text = msg.content?.trim() ?? "";
      // A veces el modelo escribe la llamada a la herramienta como texto
      // ("functions.propose_transaction {...}") en vez de ejecutarla: le
      // pedimos que la use de verdad, una sola vez.
      if (!retriedLeakedToolCall && LEAKED_TOOL_CALL.test(text)) {
        retriedLeakedToolCall = true;
        console.warn("[agent] llamada a herramienta escrita como texto; reintento");
        messages.push({
          role: "user",
          content:
            "(sistema) Escribiste la llamada a la herramienta como texto. Ejecutá la herramienta correspondiente con una llamada real, sin escribir JSON en el mensaje.",
        });
        continue;
      }
      return { reply: text || "No te entendí, ¿me lo repetís?", draft: null };
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let result: Record<string, unknown>;
      try {
        result = await executeTool(ctx, call.function.name, call.function.arguments);
      } catch (err) {
        console.error("[agent] tool error", call.function.name, err);
        result = { error: "Error interno al ejecutar la herramienta" };
      }
      if (result.error) console.warn("[agent] tool rejected", call.function.name, result.error);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }

    // Si ya hay borrador, el resumen lo arma el sistema: no hace falta otra vuelta.
    if (ctx.proposedDraft) return { reply: "", draft: ctx.proposedDraft };
  }

  return {
    reply: "Uy, me enredé con eso. ¿Me lo decís de otra forma?",
    draft: null,
  };
};
