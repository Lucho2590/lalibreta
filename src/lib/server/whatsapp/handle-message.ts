import "server-only";

import { adminDb } from "../firebase-admin";
import { createTransactionAdmin, createTransferAdmin } from "../transactions-admin";
import { Timestamp } from "firebase-admin/firestore";
import { createAccountAdmin } from "../accounts-admin";
import { createCategoryAdmin } from "../categories-admin";
import { saveStatementAdmin } from "../statements-admin";
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
import { formatMoney } from "@/lib/format";
import {
  downloadMedia,
  markAsReadWithTyping,
  sendButtons,
  sendText,
} from "./client";
import { consumeLinkCode, getLinkedUid } from "./linking";
import { loadCategoryRules } from "../statement-import";
import {
  displayNameOf,
  loadMyShares,
  loadSharedAccounts,
} from "../sharing";
import { notify } from "../notifications";
import { loadSession, saveSession, takeDraft } from "./sessions";
import {
  draftType,
  type AccountDraft,
  type CardPaymentDraft,
  type ChatTurn,
  type ExchangeDraft,
  type RecurringDraft,
  type TransferDraft,
  type StatementDraft,
  type TransactionDraft,
  type WaIncomingMessage,
} from "./types";

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const LINK_RE = /^\s*vincular\s+(\d{6})\s*$/i;
const YES_RE = /^\s*(s[ií]|si+|dale|ok|okey|confirmo|confirmar|guardalo|guardala|creala|listo)\s*[.!👍]*\s*$/i;
const NO_RE = /^\s*(no|nop|cancel(ar|á|a)?|descartar|borralo)\s*[.!]*\s*$/i;

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

  const session = await loadSession(waId, uid);

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
      const transcript = await transcribeAudio(media.data, media.mimeType);
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
        text: `(imagen: ticket, factura o resumen de tarjeta) ${caption}`.trim(),
        imageDataUrl: `data:${media.mimeType};base64,${media.data.toString("base64")}`,
      };
      historyText = `📷 [imagen] ${caption}`.trim();
      break;
    }
    case "document": {
      if (!message.document) return;
      const doc = message.document;
      const caption = doc.caption?.trim() ?? "";
      const isPdf = doc.mime_type === "application/pdf";
      const isImage = doc.mime_type.startsWith("image/");
      if (!isPdf && !isImage) {
        await sendText(waId, "De archivos solo leo PDFs e imágenes 🙂");
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
      input = isPdf
        ? {
            text: `(PDF: ${doc.filename ?? "documento"}) ${caption}`.trim(),
            pdf: {
              filename: doc.filename ?? "documento.pdf",
              dataUrl: `data:application/pdf;base64,${base64}`,
            },
          }
        : {
            text: `(imagen: ticket, factura o resumen de tarjeta) ${caption}`.trim(),
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
        "Por ahora entiendo texto, audios, fotos y PDFs 🙂",
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
  const [balances, sharedWithMe, myShares, rules] = await Promise.all([
    getBalances(uid, accounts),
    loadSharedAccounts(uid),
    loadMyShares(uid),
    loadCategoryRules(uid),
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
    return;
  }

  turns.push({ role: "assistant", content: result.reply });
  await saveSession(waId, session, turns);
  await sendText(waId, result.reply);
};

/** Primer mensaje después de vincular: presentación del agente y primer paso. */
const welcomeMessage = async (uid: string, profileName: string | null): Promise<string> => {
  const [agentName, accounts] = await Promise.all([ensureAgentName(uid), loadAccounts(uid)]);
  const hola = `¡Hola${profileName ? `, ${profileName.split(" ")[0]}` : ""}! 🎉 Soy *${agentName}*, tu agente de cuentas. Tu WhatsApp quedó vinculado.`;
  if (accounts.length === 0) {
    return `${hola}\n\nPara arrancar, contame cuál es tu *cuenta principal* (donde cobrás), en qué moneda y cuánto tenés hoy. Por ejemplo:\n• "mi cuenta principal es el Banco Galicia, ahí cobro en dólares. Tengo 3000 dólares y 150000 pesos"\n\nDespués sumamos el resto: "agregá Efectivo y Mercado Pago", "la Visa Galicia es del Galicia", etc.`;
  }
  return `${hola}\n\nYa podés mandarme cosas como:\n• "gasté 15000 en el super con la visa"\n• "nafta 30 lucas en efectivo"\n• una foto del ticket o un audio\n• el PDF del resumen de la tarjeta\n• "¿cuánto gasté este mes?"`;
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

  await createTransactionAdmin({
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

  const cuotas = draft.installments > 1 ? ` en ${draft.installments} cuotas` : "";
  await sendText(
    waId,
    `✅ Guardado: *${draft.description}* por *${formatMoney(draft.amount, draft.currency ?? "ARS")}*${cuotas} (${account.name}).${createdCategory ? `\n🏷️ Creé la categoría *${category.name}*.` : ""}`,
  );
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
    if (!parentId && item.parentName) parentId = createdIds.get(norm(item.parentName)) ?? null;
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
      "⭐ Quedó como tu cuenta principal. ¿Cuánto cobrás y qué día? (ej. \"cobro 2500 dólares todos los 5\") Así lo dejo como ingreso fijo.",
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

  const r = await saveStatementAdmin(uid, draft, mode);

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
    date: dateFromYMD(d.date),
    description: selling
      ? `Venta de ${formatMoney(d.fromAmount, "USD")}`
      : `Compra de ${formatMoney(d.toAmount, "USD")}`,
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
