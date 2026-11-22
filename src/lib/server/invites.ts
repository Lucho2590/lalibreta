import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { sendEmail } from "./resend";
import { renderAppInviteEmail } from "./mail-templates";
import { PeopleError, findUserByEmail, loadProfile } from "./connections";
import { contactIdFromEmail } from "@/lib/domain/contact-info";
import { looksLikeEmail } from "@/lib/domain/phone";

/**
 * Invitaciones a gente que todavía no usa La Libreta. Por mail las manda el
 * server; por WhatsApp las manda el usuario desde su propio WhatsApp (link
 * wa.me con el texto listo): el bot no puede escribirle a números que no le
 * hablaron primero.
 *
 * invites/{inviterUid}_{email}: { inviterUid, email, sentAt } — para no
 * mandarle el mismo mail más de una vez por día (y, más adelante, avisarle a
 * quien invitó cuando la otra persona se registre).
 */

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const sendEmailInvite = async (
  me: { uid: string },
  rawEmail: string,
  inviteeName?: string | null,
): Promise<{ email: string }> => {
  const email = rawEmail.trim().toLowerCase();
  if (!looksLikeEmail(email)) throw new PeopleError("Ingresá un email válido");
  if (await findUserByEmail(email)) {
    throw new PeopleError("Esa persona ya usa La Libreta: mandale la solicitud para conectarse.", 409);
  }
  const ref = adminDb().collection("invites").doc(`${me.uid}_${contactIdFromEmail(email)}`);
  const prev = (await ref.get()).data()?.sentAt as Timestamp | undefined;
  if (prev && Date.now() - prev.toMillis() < COOLDOWN_MS) {
    throw new PeopleError("Ya le mandaste la invitación hoy. Si no le llegó, que revise el spam.", 429);
  }
  const profile = await loadProfile(me.uid);
  const inviterName = profile.displayName?.trim() || profile.email.split("@")[0] || "Alguien";
  const { subject, html, text } = renderAppInviteEmail({
    inviterName,
    inviterEmail: profile.email || null,
    inviteeName: inviteeName?.trim() || null,
    appUrl: appUrl(),
  });
  const r = await sendEmail({ to: email, subject, html, text, replyTo: profile.email || undefined });
  if (!r.ok) throw new PeopleError("No se pudo mandar el mail. Probá de nuevo en un rato.", 502);
  await ref.set({ inviterUid: me.uid, email, channel: "email", sentAt: FieldValue.serverTimestamp() });
  return { email };
};
