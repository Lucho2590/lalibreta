import "server-only";

import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { adminDb } from "../firebase-admin";
import { countPushDevices, noticeTemplate } from "../notifications";
import { withDefaultPrefs } from "@/lib/domain/notifications";
import { WATCH_SETUP_GUIDES, watchGuide, type WatchSetupId } from "@/lib/domain/watch-setup";

/**
 * Avisos en el reloj inteligente: la guía para configurarlo (la misma que
 * muestra la app) y la copia por WhatsApp.
 */
export const WATCH_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "watch_notifications",
      description:
        "Avisos de La Libreta en el reloj inteligente (smartwatch) o en el celular. guide: estado de sus avisos y los pasos para su reloj (sin device, las opciones para preguntarle). enable_whatsapp_copy / disable_whatsapp_copy: prender o apagar la copia por WhatsApp (cada aviso le llega también por acá; sirve para relojes que no muestran los avisos de la app, como Amazfit o Xiaomi con iPhone).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["guide", "enable_whatsapp_copy", "disable_whatsapp_copy"] },
          device: {
            type: "string",
            enum: WATCH_SETUP_GUIDES.map((g) => g.id),
            description: WATCH_SETUP_GUIDES.map((g) => `${g.id}: ${g.examples}`).join("; "),
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export const WATCH_TOOL_NAMES = new Set(WATCH_TOOLS.map((t) => t.function.name));

const schema = z.object({
  action: z.enum(["guide", "enable_whatsapp_copy", "disable_whatsapp_copy"]),
  device: z.enum(WATCH_SETUP_GUIDES.map((g) => g.id) as [WatchSetupId, ...WatchSetupId[]]).optional(),
});

const TEMPLATE_PENDING =
  "Todavía no está aprobada la plantilla de WhatsApp para avisos: hasta entonces la copia solo le llega si te escribió en las últimas 24 h.";

export const runWatchTool = async (uid: string, _name: string, args: unknown): Promise<Record<string, unknown>> => {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  const { action, device } = parsed.data;
  const userRef = adminDb().collection("users").doc(uid);
  const templateReady = !!noticeTemplate();

  if (action !== "guide") {
    const on = action === "enable_whatsapp_copy";
    await userRef.set({ notificationPrefs: { whatsappCopy: on } }, { merge: true });
    return {
      ok: true,
      copiaPorWhatsapp: on,
      ...(on && !templateReady ? { aviso: TEMPLATE_PENDING } : {}),
      ...(on ? { comoProbar: "Que toque «Probar» en Notificaciones › Configuración de la app." } : {}),
    };
  }

  const [userSnap, pushDevices] = await Promise.all([userRef.get(), countPushDevices(uid)]);
  const prefs = withDefaultPrefs(userSnap.data()?.notificationPrefs);
  const estado = {
    dispositivosConAvisos: pushDevices,
    copiaPorWhatsapp: prefs.whatsappCopy,
    ...(prefs.whatsappCopy && !templateReady ? { aviso: TEMPLATE_PENDING } : {}),
  };

  if (!device) {
    return {
      estado,
      preguntale: "Qué reloj y qué celular tiene, si no lo dijo.",
      opciones: WATCH_SETUP_GUIDES.map((g) => ({ device: g.id, cuales: g.examples })),
    };
  }

  const guide = watchGuide(device);
  return {
    estado,
    reloj: guide.examples,
    ...(guide.note ? { aclaracion: guide.note } : {}),
    pasos: guide.steps,
    usaCopiaPorWhatsapp: guide.needsWhatsappCopy,
    nota: "También está en la app: Notificaciones › Configuración › «Avisos en el reloj». La copia por WhatsApp la podés prender vos si te dice que sí (enable_whatsapp_copy); en ese caso, el paso de prenderla en la app no hace falta. Su WhatsApp ya está vinculado (te habla por acá): salteá el paso de vincularlo.",
  };
};
