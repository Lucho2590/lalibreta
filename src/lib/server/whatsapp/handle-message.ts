import "server-only";

import { adminDb } from "../firebase-admin";
import { createTransactionAdmin, createTransferAdmin } from "../transactions-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createAccountAdmin } from "../accounts-admin";
import { createCategoryAdmin } from "../categories-admin";
import { saveStatementAdmin } from "../statements-admin";
import { saveBatchAdmin } from "../batch-admin";
import { MAX_SPREADSHEET_BYTES, spreadsheetKind, spreadsheetToText } from "../spreadsheet";
import {
  getBalances,
  loadAccounts,
  loadCategories,
  loadRecurring,
  toServerAccount,
} from "../queries-admin";
import { dateFromYMD } from "../time";
import { ensureAgentName } from "../onboarding";
import { runAgent, type AgentInput } from "../agent/run-agent";
import { draftButtons, pendingDatesText, renderDraft } from "../agent/render";
import { transcribeAudio } from "../agent/openai";
import { extractPdfText } from "../agent/pdf-text";
import { formatMoney } from "@/lib/format";
import {
  downloadMedia,
  markAsReadWithTyping,
  sendButtons,
  sendText,
} from "./client";
import { consumeLinkCode, getLinkedUid } from "./linking";
import { loadCategoryRules, loadStatementDraftLines } from "../statement-import";
import {
  REDEEM_ERRORS,
  displayNameOf,
  findShareCodeInText,
  joinWithCode,
  joinedMessage,
  loadMyShares,
  loadSharedAccounts,
  shareCodeExists,
} from "../sharing";
import { notify } from "../notifications";
import { ensureOfflineContact, loadPeopleContext } from "../people";
import { createSplit } from "../splits";
import { applySplitRules, createSplitRule } from "../split-rules";
import { createPersonTransfer } from "../person-transfers";
import { PeopleError } from "../connections";
import { loadSession, saveSession, takeDraft } from "./sessions";
import {
  draftType,
  type AccountDraft,
  type BatchDraft,
  type CardPaymentDraft,
  type ChatTurn,
  type ExchangeDraft,
  type RecurringDraft,
  type TransferDraft,
  type PersonTransferDraft,
  type StatementDraft,
  type TransactionDraft,
  type WaIncomingMessage,
} from "./types";

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const LINK_RE = /^\s*vincular\s+(\d{6})\s*$/i;
const YES_RE = /^\s*(s[ií]|si+|dale|ok|okey|confirmo|confirmar|guardalo|guardala|creala|listo)\s*[.!👍]*\s*$/i;
const NO_RE = /^\s*(no|nop|cancel(ar|á|a)?|descartar|borralo)\s*[.!]*\s*$/i;
// Mensajes que no necesitan al agente (sin borrador pendiente): ahorran una llamada a OpenAI.
const THANKS_RE = /^(\s*(muchas|mil|gracias|grax|genial|perfecto|buen[ií]simo|joya|excelente|b[aá]rbaro|crack|ok|dale)[\s.,!🙌🙏👏💪❤️😊😁]*)*\s*(gracias|grax|genial|perfecto|buen[ií]simo|excelente|b[aá]rbaro)[\s.,!🙌🙏👏💪❤️😊😁]*$/iu;
const ACK_RE = /^\s*(ok|oka|okey|okis|dale|listo|joya|bien|j[aej]+|👍|👌|🙌|🙏|😂|🤣|😊|❤️|✅)[\s.!👍👌🙌🙏😂🤣😊❤️✅]*$/iu;
/** Pregunta final de los resúmenes de borrador (ver render.ts). */
const DRAFT_QUESTION_RE = /(Si querés cambiar[^\n]*)?¿L[oa]s? (guardo|registro|creo|cargo)\?\s*$/;
/** Tipos que se ignoran en silencio (reacciones a mensajes, stickers). */
const IGNORED_TYPES = new Set(["reaction", "sticker"]);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
// El cuerpo de un mensaje con botones admite hasta 1024 caracteres.
const MAX_BUTTON_BODY = 1000;

type DraftAction = "confirm" | "summary" | "cancel";

export const handleIncomingMessage = async (
  message: WaIncomingMessage,
  profileName: string | null,
) => {
  const waId = message.from;
  // "Leído" + "escribiendo…": best-effort.
  markAsReadWithTyping(message.id).catch((err) =>
    console.warn("[wa] markAsRead falló", err),
  );

  try {
    await routeMessage(waId, message, profileName);
  } catch (err) {
    console.error("[wa] error procesando mensaje", message.id, err);
    await sendText(
      waId,
      "Uy, algo falló de mi lado 😕. Probá de nuevo en un ratito.",
    ).catch(() => {});
  }
};

const routeMessage = async (
  waId: string,
  message: WaIncomingMessage,
  profileName: string | null,
) => {
  const text = message.type === "text" ? (message.text?.body ?? "").trim() : "";
  const uid = await getLinkedUid(waId);

  // === Número sin vincular ===
  if (!uid) {
    const match = LINK_RE.exec(text);
    if (match) {
      const result = await consumeLinkCode(match[1], waId, profileName);
      if (result.ok) {
        await sendText(waId, await welcomeMessage(result.uid, profileName));
      } else {
        await sendText(
          waId,
          result.reason === "expired"
            ? "Ese código venció. Generá uno nuevo en la app y mandámelo de nuevo."
            : "Ese código no es válido. Fijate en la app y mandame: vincular 123456",
        );
      }
      return;
    }
    if (findShareCodeInText(text)?.explicit) {
      await sendText(
        waId,
        `Hola 👋 Para sumarte a esa cuenta compartida primero creá tu usuario en *La Libreta* y vinculá este número:\n\n1. Entrá a ${appUrl()}/whatsapp\n2. Tocá "Vincular WhatsApp"\n3. Mandame el mensaje: vincular <código>\n\nDespués reenviame de nuevo la invitación y listo.`,
      );
      return;
    }
    await sendText(
      waId,
      `Hola 👋 Soy el asistente de *La Libreta*. Para empezar, vinculá tu número:\n\n1. Entrá a ${appUrl()}/whatsapp\n2. Tocá "Vincular WhatsApp"\n3. Mandame el mensaje: vincular <código>`,
    );
    return;
  }

  // === Botones de los borradores ===
  const buttonId =
    message.interactive?.button_reply?.id ?? message.button?.payload ?? null;
  if (buttonId) {
    const [action, draftId] = buttonId.split(":");
    if (action === "confirm" || action === "cancel" || action === "summary") {
      await decideDraft(waId, uid, draftId ?? null, action);
      return;
    }
  }

  if (IGNORED_TYPES.has(message.type)) return;

  const session = await loadSession(waId, uid);

  // Invitación a una cuenta compartida (reenviada o "unirme 123456"): se
  // resuelve directo, sin pasar por el agente.
  const shareCode = text ? findShareCodeInText(text) : null;
  if (shareCode && (shareCode.explicit || (await shareCodeExists(shareCode.code)))) {
    const r = await joinWithCode(uid, shareCode.code);
    const reply = r.ok ? joinedMessage(r) : REDEEM_ERRORS[r.reason];
    await saveSession(waId, session, [
      { role: "user", content: text },
      { role: "assistant", content: reply },
    ]);
    await sendText(waId, reply);
    return;
  }

  // "si" / "no" en texto cuando hay un borrador esperando.
  if (session.pendingDraft && text) {
    if (YES_RE.test(text)) {
      await decideDraft(waId, uid, session.pendingDraft.id, "confirm");
      return;
    }
    if (NO_RE.test(text)) {
      await decideDraft(waId, uid, session.pendingDraft.id, "cancel");
      return;
    }
  }

  // "gracias", "ok", "👍" sin nada pendiente: respuesta fija, sin pasar por el agente.
  // Si el agente acaba de preguntar algo, "dale" es una respuesta: va al agente.
  // (El "¿Lo guardo?" de un borrador ya resuelto no cuenta como pregunta.)
  const lastReply = (session.history.findLast((t) => t.role === "assistant")?.content ?? "")
    .replace(DRAFT_QUESTION_RE, "");
  if (!session.pendingDraft && text.length <= 40 && !lastReply.includes("?")) {
    if (THANKS_RE.test(text)) {
      await sendText(waId, "¡De nada! 🙌");
      return;
    }
    if (ACK_RE.test(text)) return;
  }

  // === Armar la entrada para el agente según el tipo de mensaje ===
  let input: AgentInput;
  let historyText: string;
  switch (message.type) {
    case "text": {
      if (!text) return;
      input = { text };
      historyText = text;
      break;
    }
    case "audio": {
      if (!message.audio) return;
      const media = await downloadMedia(message.audio.id);
      const transcript = await transcribeAudio(media.data, media.mimeType, uid);
      if (!transcript) {
        await sendText(waId, "No llegué a entender el audio 🙉. ¿Me lo mandás de nuevo o por escrito?");
        return;
      }
      input = { text: `(nota de voz transcripta) ${transcript}` };
      historyText = `🎙️ ${transcript}`;
      break;
    }
    case "image": {
      if (!message.image) return;
      const media = await downloadMedia(message.image.id);
      if (media.data.length > MAX_IMAGE_BYTES) {
        await sendText(waId, "La foto es muy pesada. ¿Me mandás una más liviana?");
        return;
      }
      const caption = message.image.caption?.trim() ?? "";
      input = {
        text: `(imagen: ticket, factura, resumen de tarjeta o lista de gastos) ${caption}`.trim(),
        imageDataUrl: `data:${media.mimeType};base64,${media.data.toString("base64")}`,
      };
      historyText = `📷 [imagen] ${caption}`.trim();
      break;
    }
    case "document": {
      if (!message.document) return;
      const doc = message.document;
      const caption = doc.caption?.trim() ?? "";
      const sheet = spreadsheetKind(doc.mime_type, doc.filename);
      if (sheet === "xls") {
        await sendText(
          waId,
          "Ese Excel es del formato viejo (.xls) y no lo puedo abrir 😕. Guardalo como .xlsx o .csv y mandámelo de nuevo, o mandame una captura.",
        );
        return;
      }
      if (sheet) {
        const media = await downloadMedia(doc.id);
        if (media.data.length > MAX_SPREADSHEET_BYTES) {
          await sendText(waId, "La planilla es muy pesada. ¿Me mandás una más chica (o solo la hoja de los gastos)?");
          return;
        }
        let table: Awaited<ReturnType<typeof spreadsheetToText>>;
        try {
          table = await spreadsheetToText(media.data, sheet);
        } catch (err) {
          console.warn("[wa] no se pudo leer la planilla", err);
          await sendText(waId, "No pude abrir esa planilla 😕. ¿Me la mandás como .xlsx o .csv, o una captura?");
          return;
        }
        if (!table.text) {
          await sendText(waId, "La planilla está vacía 🤔");
          return;
        }
        const name = doc.filename ?? "planilla";
        input = {
          text: `(planilla: ${name}${table.truncated ? `, muestro las primeras filas de ${table.rows}` : ""}) ${caption}\n\n${table.text}`.trim(),
        };
        historyText = `📊 [${name}] ${caption}`.trim();
        await sendText(waId, "Dame un toque que la leo 📊👀");
        break;
      }
      const isPdf = doc.mime_type === "application/pdf";
      const isImage = doc.mime_type.startsWith("image/");
      if (!isPdf && !isImage) {
        await sendText(waId, "De archivos leo PDFs, imágenes y planillas (Excel o CSV) 🙂");
        return;
      }
      const media = await downloadMedia(doc.id);
      if (media.data.length > (isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
        await sendText(waId, "El archivo es muy pesado. ¿Me mandás uno más liviano?");
        return;
      }
      if (isPdf && isEncryptedPdf(media.data)) {
        await sendText(
          waId,
          "Ese PDF tiene contraseña 🔒 y no lo puedo abrir. Mandame una versión sin contraseña o capturas de pantalla del resumen.",
        );
        return;
      }
      const base64 = media.data.toString("base64");
      const filename = doc.filename ?? "documento.pdf";
      // PDF con texto: mandamos el texto (sin las imágenes de cada página, mucho más barato).
      const pdfText = isPdf ? await extractPdfText(media.data) : null;
      input = pdfText
        ? {
            text: `(PDF: ${filename}, texto extraído respetando las columnas) ${caption}`.trim(),
            documentText: pdfText,
          }
        : isPdf
        ? {
            text: `(PDF: ${doc.filename ?? "documento"}) ${caption}`.trim(),
            pdf: {
              filename: doc.filename ?? "documento.pdf",
              dataUrl: `data:application/pdf;base64,${base64}`,
            },
          }
        : {
            text: `(imagen: ticket, factura, resumen de tarjeta o lista de gastos) ${caption}`.trim(),
            imageDataUrl: `data:${media.mimeType};base64,${base64}`,
          };
      historyText = `📄 [${doc.filename ?? "archivo"}] ${caption}`.trim();
      // Leer un resumen largo tarda: avisamos para que no parezca colgado.
      if (isPdf) await sendText(waId, "Dame un toque que lo leo 📄👀");
      break;
    }
    default:
      await sendText(
        waId,
        "Por ahora entiendo texto, audios, fotos, PDFs y planillas (Excel o CSV) 🙂",
      );
      return;
  }

  const [accounts, categories, recurring, userSnap] = await Promise.all([
    loadAccounts(uid),
    loadCategories(uid),
    loadRecurring(uid),
    adminDb().collection("users").doc(uid).get(),
  ]);
  const userName =
    (userSnap.data()?.displayName as string | undefined) ?? profileName ?? null;
  const agentName =
    (userSnap.data()?.agentName as string | undefined) ?? (await ensureAgentName(uid));
  const [balances, sharedWithMe, myShares, rules, peopleCtx] = await Promise.all([
    getBalances(uid, accounts),
    loadSharedAccounts(uid),
    loadMyShares(uid),
    loadCategoryRules(uid),
    loadPeopleContext(uid),
  ]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const categoryRules = rules
    .filter((r) => catName.has(r.categoryId))
    .sort((a, b) => b.count - a.count)
    .slice(0, 80)
    .map((r) => ({ sample: r.sample, categoryName: catName.get(r.categoryId)! }));

  const result = await runAgent(
    {
      uid,
      userName,
      agentName,
      accounts,
      categories,
      recurring,
      balances,
      sharedWithMe,
      myShares,
      categoryRules,
      pendingDraft: session.pendingDraft,
      people: peopleCtx.people,
      pending: peopleCtx.pending,
      splitRules: peopleCtx.rules.map((r) => ({
        label: r.label,
        people: r.participants
          .map((p) => `${p.name} ${p.shareType === "percent" ? `${p.value}%` : formatMoney(p.value, "ARS")}`)
          .join(", "),
      })),
    },
    session.history,
    input,
  );

  const turns: ChatTurn[] = [{ role: "user", content: historyText }];

  if (result.draft) {
    const summary = renderDraft(result.draft);
    session.pendingDraft = result.draft;
    turns.push({ role: "assistant", content: summary });
    await saveSession(waId, session, turns);
    const buttons = draftButtons(result.draft);
    if (summary.length > MAX_BUTTON_BODY) {
      await sendText(waId, summary);
      await sendButtons(waId, "¿Qué hago?", buttons);
    } else {
      await sendButtons(waId, summary, buttons);
    }
    for (const extra of result.outbox) await sendText(waId, extra);
    return;
  }

  turns.push({ role: "assistant", content: result.reply });
  for (const extra of result.outbox) turns.push({ role: "assistant", content: extra });
  await saveSession(waId, session, turns);
  await sendText(waId, result.reply);
  for (const extra of result.outbox) await sendText(waId, extra);
};

/** Primer mensaje después de vincular: presentación del agente y primer paso. */
const welcomeMessage = async (uid: string, profileName: string | null): Promise<string> => {
  const [agentName, accounts] = await Promise.all([ensureAgentName(uid), loadAccounts(uid)]);
  const hola = `¡Hola${profileName ? `, ${profileName.split(" ")[0]}` : ""}! 🎉 Soy *${agentName}*, tu agente de cuentas. Tu WhatsApp quedó vinculado.`;
  if (accounts.length === 0) {
    return `${hola}\n\nPara arrancar, contame cuál es tu *cuenta principal* (donde cobrás), en qué moneda y cuánto tenés hoy. Por ejemplo:\n• "mi cuenta principal es el Banco Galicia, ahí cobro. Tengo 850000 pesos"\n(si también tenés dólares, sumalo: "…y 500 dólares")\n\nDespués sumamos el resto: "agregá Efectivo y Mercado Pago", "la Visa Galicia es del Galicia", etc.`;
  }
  return `${hola}\n\nYa podés mandarme cosas como:\n• "gasté 15000 en el super con la visa"\n• "nafta 30 lucas en efectivo"\n• una foto del ticket o un audio\n• el PDF del resumen de la tarjeta\n• una captura de los consumos de la tarjeta o un Excel con tus gastos\n• "¿cuánto gasté este mes?"`;
};

/** Los PDFs con contraseña declaran un diccionario /Encrypt. */
const isEncryptedPdf = (data: Buffer): boolean => data.includes("/Encrypt");

const decideDraft = async (
  waId: string,
  uid: string,
  draftId: string | null,
  action: DraftAction,
) => {
  const draft = await takeDraft(waId, uid, draftId);
  if (!draft) {
    await sendText(
      waId,
      "Eso ya no está pendiente (ya lo resolviste o pasó mucho tiempo). Si querés, mandámelo de nuevo.",
    );
    return;
  }

  if (action === "cancel") {
    await sendText(waId, "Listo, lo descarté 🗑️");
    return;
  }

  switch (draftType(draft)) {
    case "batch":
      await confirmBatch(waId, uid, draft as BatchDraft);
      return;
    case "account":
      await confirmAccount(waId, uid, draft as AccountDraft);
      return;
    case "statement":
      await confirmStatement(waId, uid, draft as StatementDraft, action === "summary" ? "summary" : "all");
      return;
    case "exchange":
      await confirmExchange(waId, uid, draft as ExchangeDraft);
      return;
    case "card-payment":
      await confirmCardPayment(waId, uid, draft as CardPaymentDraft);
      return;
    case "recurring":
      await confirmRecurring(waId, uid, draft as RecurringDraft);
      return;
    case "transfer":
      await confirmTransfer(waId, uid, draft as TransferDraft);
      return;
    case "person-transfer":
      await confirmPersonTransfer(waId, uid, draft as PersonTransferDraft);
      return;
    default:
      await confirmTransaction(waId, uid, draft as TransactionDraft);
  }
};

const confirmTransaction = async (waId: string, uid: string, draft: TransactionDraft) => {
  if (draft.shared) {
    await confirmSharedTransaction(waId, uid, draft);
    return;
  }
  // Revalidamos: la cuenta o la categoría pudieron borrarse mientras tanto.
  const [accounts, categories] = await Promise.all([
    loadAccounts(uid),
    loadCategories(uid),
  ]);
  const account = accounts.find((a) => a.id === draft.accountId && a.active);
  let category: { id: string; name: string } | undefined = categories.find(
    (c) => c.id === draft.categoryId,
  );
  let createdCategory = false;
  if (!category && draft.newCategory && account) {
    const r = await createCategoryAdmin(uid, draft.newCategory);
    category = { id: r.id, name: r.name };
    createdCategory = r.created;
  }
  if (!account || !category) {
    await sendText(
      waId,
      "No pude guardarlo porque la cuenta o la categoría ya no existen. Mandámelo de nuevo.",
    );
    return;
  }

  const txId = await createTransactionAdmin({
    ownerUid: uid,
    account: toServerAccount(account),
    accountId: account.id,
    categoryId: category.id,
    description: draft.description,
    totalAmount: draft.amount,
    purchaseDate: dateFromYMD(draft.date),
    kind: draft.kind,
    installments: draft.installments,
    cardClosedAtPurchase: draft.cardClosedAtPurchase,
    currency: draft.currency ?? "ARS",
  });

  // Dividirlo: los nuevos sin app se agregan como contactos; el server avisa a los que usan la app.
  let splitText = "";
  if (!draft.split?.people.length && draft.kind === "expense") {
    // Lo que se divide siempre (ej. el seguro con Orne) se divide solo.
    const auto = await applySplitRules(uid, [txId]).catch(() => []);
    if (auto.length) splitText = `\n👥 Lo dividí con ${auto[0].names.join(" y ")}, como siempre.`;
  }
  if (draft.split?.people.length) {
    try {
      const participants = [];
      for (const p of draft.split.people) {
        const ref = p.ref ?? (await ensureOfflineContact(uid, p.newName ?? p.name));
        participants.push({ ref, shareType: p.shareType, value: p.value });
      }
      await createSplit({ uid }, { txId, mode: draft.split.mode, participants });
      if (draft.split.always) {
        const rule = await createSplitRule(uid, { txId, mode: draft.split.mode, participants });
        splitText += `\n🔁 De ahora en más, *${rule.label}* se divide siempre así${rule.applied ? ` (ya dividí ${rule.applied} más de este mes)` : ""}.`;
      }
      const apps = draft.split.people.filter((p) => p.isApp).map((p) => p.name.split(" ")[0]);
      const offline = draft.split.people.filter((p) => !p.isApp).map((p) => p.name.split(" ")[0]);
      splitText = [
        splitText,
        apps.length ? `\n👥 A ${apps.join(" y ")} le${apps.length > 1 ? "s" : ""} llegó para aceptar su parte.` : "",
        offline.length ? `\n📝 Anoté que ${offline.join(" y ")} te debe${offline.length > 1 ? "n" : ""} su parte; te voy a recordar cobrar.` : "",
      ].join("");
    } catch (err) {
      splitText = `\n⚠️ No pude dividirlo: ${err instanceof PeopleError ? err.message : "error"}. Podés hacerlo desde la app.`;
    }
  }

  const cuotas = draft.installments > 1 ? ` en ${draft.installments} cuotas` : "";
  await sendText(
    waId,
    `✅ Guardado: *${draft.description}* por *${formatMoney(draft.amount, draft.currency ?? "ARS")}*${cuotas} (${account.name}).${createdCategory ? `\n🏷️ Creé la categoría *${category.name}*.` : ""}${splitText}`,
  );
};

const confirmPersonTransfer = async (waId: string, uid: string, d: PersonTransferDraft) => {
  try {
    const person = d.ref ?? (await ensureOfflineContact(uid, d.newName ?? d.personName));
    const r = await createPersonTransfer({ uid }, {
      person,
      direction: d.direction,
      kind: d.kind,
      accountId: d.accountId,
      amount: d.amount,
      currency: d.currency,
      date: d.date,
    });
    const what =
      d.direction === "in"
        ? `${d.personName} te pasó *${formatMoney(d.amount, d.currency)}* (entró en ${d.accountName})`
        : `${d.kind === "loan" ? "Le prestaste" : "Le pasaste"} a ${d.personName} *${formatMoney(d.amount, d.currency)}* (salió de ${d.accountName})`;
    await sendText(
      waId,
      `✅ Anotado: ${what}.${r.status === "pending" ? `\n⏳ ${d.personName.split(" ")[0]} lo tiene que confirmar en la app.` : ""}`,
    );
  } catch (err) {
    await sendText(waId, `No pude registrarlo: ${err instanceof PeopleError ? err.message : "error"}.`);
  }
};

const confirmBatch = async (waId: string, uid: string, draft: BatchDraft) => {
  const r = await saveBatchAdmin(uid, draft);
  if (r.created === 0) {
    await sendText(waId, "No pude cargar ninguno: las cuentas o categorías ya no existen. Mandámelo de nuevo.");
    return;
  }
  const parts = [
    r.totals.ARS ? formatMoney(r.totals.ARS, "ARS") : null,
    r.totals.USD ? formatMoney(r.totals.USD, "USD") : null,
  ].filter(Boolean);
  const lines = [
    `✅ Cargué ${r.created === 1 ? "1 movimiento" : `${r.created} movimientos`}${parts.length ? ` (${parts.join(" + ")})` : ""}.`,
  ];
  if (r.failed.length > 0) lines.push(`No pude cargar: ${r.failed.join(", ")} (la cuenta o la categoría ya no existe).`);
  if (r.cardsPendingDates.length > 0) lines.push("", pendingDatesText(r.cardsPendingDates));
  for (const a of r.splitApplied) lines.push(`👥 *${a.label}*: lo dividí con ${a.names.join(" y ")} (como siempre).`);
  await sendText(waId, lines.join("\n"));
};

const rank = (t: string) => (t === "credit" || t === "reserve" ? 1 : 0);

const confirmAccount = async (waId: string, uid: string, draft: AccountDraft) => {
  const accounts = await loadAccounts(uid);
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
  const existingIds = new Set(accounts.map((a) => a.id));
  const taken = new Set(accounts.map((a) => norm(a.name)));
  const createdIds = new Map<string, string>();
  const created: string[] = [];
  const skipped: string[] = [];

  // Primero las que no son tarjeta, para poder colgar las tarjetas de ellas.
  const ordered = [...draft.accounts].sort(
    // Primero las cuentas madre; después tarjetas y cobachas (que cuelgan de ellas).
    (a, b) => rank(a.accountType) - rank(b.accountType),
  );
  for (const item of ordered) {
    if (taken.has(norm(item.name))) {
      skipped.push(item.name);
      continue;
    }
    let parentId = item.parentId && existingIds.has(item.parentId) ? item.parentId : null;
    if (!parentId && item.parentName) {
      parentId =
        createdIds.get(norm(item.parentName)) ??
        // La madre ya existía (p. ej. se repitió en la lista y se salteó).
        accounts.find(
          (a) =>
            norm(a.name) === norm(item.parentName!) &&
            a.type !== "credit" &&
            a.type !== "reserve" &&
            !a.parentId,
        )?.id ??
        null;
    }
    const id = await createAccountAdmin(uid, {
      name: item.name,
      type: item.accountType,
      closingDay: item.closingDay,
      dueDay: item.dueDay,
      parentId,
      last4: item.last4,
      currencies: item.currencies,
      isMain: item.isMain,
      openingBalances: item.openingBalances,
    });
    createdIds.set(norm(item.name), id);
    taken.add(norm(item.name));
    created.push(item.name);
  }

  const lines: string[] = [];
  if (created.length > 0) {
    lines.push(
      created.length === 1
        ? `✅ Cuenta *${created[0]}* creada.`
        : `✅ Creé ${created.length} cuentas: ${created.map((n) => `*${n}*`).join(", ")}.`,
    );
  }
  if (skipped.length > 0) lines.push(`(Ya existían: ${skipped.join(", ")})`);
  const pending = draft.accounts
    .filter((a) => a.accountType === "credit" && !a.closingDay && created.includes(a.name))
    .map((a) => a.name);
  if (pending.length > 0) lines.push("", pendingDatesText(pending));
  if (draft.accounts.some((a) => a.isMain && created.includes(a.name))) {
    lines.push(
      "",
      "⭐ Quedó como tu cuenta principal. ¿Cuánto cobrás y qué día? (ej. \"cobro 1500000 pesos todos los 5\") Así lo dejo como ingreso fijo.",
      "Y ya podés mandarme gastos, audios, fotos de tickets o el PDF del resumen de la tarjeta 🚀",
    );
  } else if (accounts.length === 0 && created.length > 0) {
    lines.push(
      "",
      "¡Ya estás listo! 🚀 Mandame tus gastos como te salgan: \"gasté 5000 en el super\", un audio, la foto del ticket o el PDF del resumen de la tarjeta.",
    );
  } else if (created.length > 0) {
    lines.push("Ya podés cargar gastos con ellas.");
  }
  await sendText(waId, lines.join("\n"));
};

const confirmStatement = async (
  waId: string,
  uid: string,
  draft: StatementDraft,
  mode: "all" | "summary",
) => {
  // Revalidamos la tarjeta y las categorías.
  const [accounts, categories] = await Promise.all([loadAccounts(uid), loadCategories(uid)]);
  if (draft.accountId && !accounts.some((a) => a.id === draft.accountId)) {
    await sendText(waId, "La tarjeta de ese resumen ya no existe. Mandámelo de nuevo.");
    return;
  }
  const catIds = new Set(categories.map((c) => c.id));
  if (draft.chargesCategoryId && !catIds.has(draft.chargesCategoryId)) draft.chargesCategoryId = null;
  draft.subscriptions = draft.subscriptions.filter((s) => catIds.has(s.categoryId));

  // "Guardar todo": el detalle se carga renglón por renglón (incluidos los
  // impuestos), salvo que los cargos ya estuvieran como un solo gasto.
  const r = await saveStatementAdmin(uid, draft, mode, { chargesAsLines: true });
  const loaded =
    mode === "all"
      ? await loadStatementDraftLines(uid, draft, r.accountId, r.chargesTransaction === "already-existed")
      : null;

  const lines = [`✅ Resumen de *${r.accountName}* guardado.`];
  if (r.createdAccount) lines.push("• Creé la tarjeta en tus cuentas.");
  if (r.datesCompleted) {
    lines.push(
      `• Completé el cierre y el vencimiento de la tarjeta${r.purchasesReorganized ? ` y acomodé ${r.purchasesReorganized} ${r.purchasesReorganized === 1 ? "gasto" : "gastos"} en el resumen que corresponde` : ""}.`,
    );
  }
  lines.push(
    `• Fechas de cierre y vencimiento actualizadas${r.installmentsUpdated ? ` (${r.installmentsUpdated} cuotas ajustadas)` : ""}.`,
  );
  if (r.chargesTransaction === "created") {
    const parts = [
      draft.chargesARS > 0 ? formatMoney(draft.chargesARS, "ARS") : null,
      (draft.chargesUSD ?? 0) > 0 ? formatMoney(draft.chargesUSD!, "USD") : null,
    ].filter(Boolean);
    lines.push(`• Cargué ${parts.join(" + ")} de impuestos y cargos como gasto.`);
  } else if (r.chargesTransaction === "already-existed") {
    lines.push("• Los impuestos y cargos de este resumen ya estaban cargados, no los dupliqué.");
  }
  if (loaded) {
    if (loaded.created > 0) {
      lines.push(
        `• Cargué ${loaded.created} ${loaded.created === 1 ? "movimiento" : "movimientos"} del detalle (consumos, cuotas, impuestos y reintegros)${loaded.duplicates ? `; ${loaded.duplicates} ya ${loaded.duplicates === 1 ? "estaba cargado" : "estaban cargados"} y no los repetí` : ""}.`,
      );
    } else if (loaded.duplicates > 0) {
      lines.push("• Los movimientos de este resumen ya estaban cargados, no los dupliqué.");
    }
  }
  if (r.subscriptionsCreated.length > 0) {
    lines.push(`• Fijos nuevos: ${r.subscriptionsCreated.join(", ")}.`);
  }
  if (r.subscriptionsSkipped.length > 0) {
    lines.push(`• Ya existían como fijo: ${r.subscriptionsSkipped.join(", ")}.`);
  }
  await sendText(waId, lines.join("\n"));
};

const confirmExchange = async (waId: string, uid: string, d: ExchangeDraft) => {
  const accounts = await loadAccounts(uid);
  const from = accounts.find((a) => a.id === d.fromAccountId);
  const to = accounts.find((a) => a.id === d.toAccountId);
  if (!from || !to) {
    await sendText(waId, "No pude registrarlo porque una de las cuentas ya no existe.");
    return;
  }
  const selling = d.fromCurrency === "USD";
  await createTransferAdmin({
    ownerUid: uid,
    fromAccountId: from.id,
    toAccountId: to.id,
    amount: d.fromAmount,
    currency: d.fromCurrency,
    toAmount: d.toAmount,
    toCurrency: d.toCurrency,
    rate: d.rate,
    ...(d.exchangeDiff && d.quotedRate ? { quotedRate: d.quotedRate, exchangeDiff: d.exchangeDiff } : {}),
    date: dateFromYMD(d.date),
    description:
      (selling
        ? `Venta de ${formatMoney(d.fromAmount, "USD")}`
        : `Compra de ${formatMoney(d.toAmount, "USD")}`) + (d.withWhom ? ` · ${d.withWhom}` : ""),
    transferType: "exchange",
  });
  const bal = await getBalances(uid);
  const left = [from, ...(to.id !== from.id ? [to] : [])]
    .map((a) => {
      const b = bal.accounts.find((x) => x.id === a.id)?.amounts;
      return b ? `${a.name}: ${a.currencies.map((c) => formatMoney(b[c], c)).join(" · ")}` : null;
    })
    .filter(Boolean);
  await sendText(
    waId,
    `✅ Listo: ${selling ? "vendiste" : "compraste"} *${formatMoney(selling ? d.fromAmount : d.toAmount, "USD")}* a ${formatMoney(d.rate, "ARS")}.\n💰 ${left.join("\n💰 ")}`,
  );
};

const confirmCardPayment = async (waId: string, uid: string, d: CardPaymentDraft) => {
  const accounts = await loadAccounts(uid);
  const card = accounts.find((a) => a.id === d.cardId);
  const from = accounts.find((a) => a.id === d.fromAccountId);
  if (!card || !from) {
    await sendText(waId, "No pude registrarlo porque la tarjeta o la cuenta ya no existen.");
    return;
  }
  for (const p of d.payments) {
    await createTransferAdmin({
      ownerUid: uid,
      fromAccountId: from.id,
      toAccountId: card.id,
      amount: p.payAmount,
      currency: p.payWith,
      toAmount: p.amount,
      toCurrency: p.currency,
      ...(p.rate ? { rate: p.rate } : {}),
      date: dateFromYMD(d.date),
      description: `Pago ${card.name}`,
      transferType: "card-payment",
    });
  }
  const paid = d.payments.map((p) => formatMoney(p.amount, p.currency)).join(" + ");
  await sendText(waId, `✅ Registré el pago de *${card.name}*: ${paid}, desde ${from.name}.`);
};

const confirmRecurring = async (waId: string, uid: string, d: RecurringDraft) => {
  const accounts = await loadAccounts(uid);
  if (!accounts.some((a) => a.id === d.accountId)) {
    await sendText(waId, "No pude guardarlo porque la cuenta ya no existe.");
    return;
  }
  await adminDb().collection(`users/${uid}/recurring`).add({
    name: d.name,
    amount: d.amount,
    currency: d.currency,
    accountId: d.accountId,
    categoryId: d.categoryId,
    kind: d.kind,
    dayOfMonth: d.dayOfMonth,
    startMonth: d.startMonth,
    endMonth: null,
    active: true,
    createdAt: Timestamp.now(),
  });
  await sendText(
    waId,
    `✅ Guardé el ${d.kind === "income" ? "ingreso" : "gasto"} fijo *${d.name}* (${formatMoney(d.amount, d.currency)} todos los ${d.dayOfMonth}).\nCada mes aparece en el inicio de la app para aplicarlo. Si ya ${d.kind === "income" ? "cobraste" : "pagaste"} el de este mes, decime y lo cargo.`,
  );
};

const confirmTransfer = async (waId: string, uid: string, d: TransferDraft) => {
  const accounts = await loadAccounts(uid);
  const from = accounts.find((a) => a.id === d.fromAccountId);
  const to = accounts.find((a) => a.id === d.toAccountId);
  if (!from || !to) {
    await sendText(waId, "No pude registrarlo porque una de las cuentas ya no existe.");
    return;
  }
  if (!to.currencies.includes(d.currency)) {
    await adminDb()
      .doc(`users/${uid}/accounts/${to.id}`)
      .update({ currencies: FieldValue.arrayUnion(...to.currencies, d.currency) });
    to.currencies = [...to.currencies, d.currency];
  }
  await createTransferAdmin({
    ownerUid: uid,
    fromAccountId: from.id,
    toAccountId: to.id,
    amount: d.amount,
    currency: d.currency,
    date: dateFromYMD(d.date),
    description: d.description,
    transferType: "transfer",
  });
  const bal = await getBalances(uid);
  const left = [from, to]
    .map((a) => {
      const b = bal.accounts.find((x) => x.id === a.id)?.amounts;
      return b ? `${a.name}: ${formatMoney(b[d.currency], d.currency)}` : null;
    })
    .filter(Boolean);
  await sendText(waId, `✅ Listo: ${formatMoney(d.amount, d.currency)} de ${from.name} a ${to.name}.\n💰 ${left.join("\n💰 ")}`);
};

/**
 * Gasto sobre una cuenta que otra persona compartió: entra directo a la cuenta
 * del dueño (con "cargado por") y se le avisa (app, push o WhatsApp).
 */
const confirmSharedTransaction = async (waId: string, uid: string, draft: TransactionDraft) => {
  const shared = draft.shared!;
  const stillShared = (await loadSharedAccounts(uid)).find((s) => s.shareId === shared.shareId);
  if (!stillShared) {
    await sendText(waId, "Esa cuenta ya no está compartida con vos, así que no lo pude cargar.");
    return;
  }
  // La categoría elegida es del que carga: buscamos la del dueño con el mismo nombre.
  const norm = (x: string) => x.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
  const ownerCats = await loadCategories(shared.ownerUid);
  const wanted = draft.newCategory?.name ?? draft.categoryName;
  const category =
    ownerCats.find((c) => c.kind === "expense" && norm(c.name) === norm(wanted)) ??
    ownerCats.find((c) => c.kind === "expense" && /^otro/.test(norm(c.name))) ??
    ownerCats.find((c) => c.kind === "expense");
  if (!category) {
    await sendText(waId, `No pude cargarlo: ${shared.ownerName} no tiene categorías de gasto.`);
    return;
  }

  const me = await displayNameOf(uid);
  const account = stillShared.account;
  await createTransactionAdmin({
    ownerUid: shared.ownerUid,
    account: toServerAccount(account),
    accountId: account.id,
    categoryId: category.id,
    description: draft.description,
    totalAmount: draft.amount,
    purchaseDate: dateFromYMD(draft.date),
    kind: "expense",
    installments: draft.installments,
    cardClosedAtPurchase: draft.cardClosedAtPurchase,
    currency: draft.currency ?? "ARS",
    createdBy: { uid, name: me },
  });

  const money = formatMoney(draft.amount, draft.currency ?? "ARS");
  const cuotas = draft.installments > 1 ? ` en ${draft.installments} cuotas` : "";
  const notified = (
    await notify(shared.ownerUid, {
      kind: "shared-expense",
      title: `${me} cargó ${draft.description}`,
      body: `${money}${cuotas} con tu ${account.name} · ${category.name}`,
      url: `/cuentas/${account.id}`,
      whatsappText: `🧾 *${me}* cargó *${draft.description}* por *${money}*${cuotas} con tu *${account.name}* (${category.name}).`,
    })
  ).stored;
  await sendText(
    waId,
    `✅ Cargado en la *${account.name}* de ${shared.ownerName}: *${draft.description}* por *${money}*${cuotas}.${notified ? ` Le avisé a ${shared.ownerName}.` : ""}`,
  );
};
