import "server-only";

import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM ?? "Saldo <onboarding@resend.dev>";
const devLog = process.env.EMAIL_DEV_LOG === "true";

let clientSingleton: Resend | null = null;

const getClient = (): Resend | null => {
  if (clientSingleton) return clientSingleton;
  if (!apiKey) return null;
  clientSingleton = new Resend(apiKey);
  return clientSingleton;
};

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  loggedOnly?: boolean;
}

const logFakeSend = (input: SendEmailInput): SendEmailResult => {
  console.log(
    "\n========= [EMAIL DEV LOG] =========\n" +
      `From:    ${from}\n` +
      `To:      ${Array.isArray(input.to) ? input.to.join(", ") : input.to}\n` +
      `Subject: ${input.subject}\n` +
      `--- text ---\n${input.text ?? "(no text)"}\n` +
      `--- html ---\n${input.html}\n` +
      "===================================\n",
  );
  return { ok: true, id: "dev-log", loggedOnly: true };
};

export const sendEmail = async (
  input: SendEmailInput,
): Promise<SendEmailResult> => {
  if (devLog) {
    return logFakeSend(input);
  }

  const client = getClient();
  if (!client) {
    console.warn(
      "[resend] RESEND_API_KEY no configurada — log a consola y sigo:",
    );
    return logFakeSend(input);
  }

  try {
    console.log("[resend] enviando", {
      from,
      to: input.to,
      subject: input.subject,
    });
    const result = await client.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
    });
    if (result.error) {
      console.error("[resend] error de Resend:", result.error);
      return {
        ok: false,
        error:
          (result.error as { message?: string; name?: string }).message ??
          (result.error as { name?: string }).name ??
          "Error de Resend",
      };
    }
    console.log("[resend] enviado ok", result.data?.id);
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error("[resend] excepción", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Error de Resend",
    };
  }
};

export const emailFrom = (): string => from;
