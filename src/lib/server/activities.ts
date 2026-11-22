import "server-only";

import { createHash } from "node:crypto";
import { FieldValue, type DocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { notify } from "./notifications";
import { sendEmail } from "./resend";
import { renderActivityInviteEmail, renderActivityNoticeEmail } from "./mail-templates";
import { todayYMD } from "./time";
import {
  activitiesCollectionPath,
  activityLinksCollectionPath,
  activityBaseFields,
  activityIndexFields,
  compareActivities,
  dayLabel,
  mergeParticipants,
  participantName,
  type Activity,
  type ActivityInput,
  type ActivityLink,
  type ActivityParticipant,
  type Invitee,
} from "@/lib/domain/activity-model";
import type { NotificationKind, NotificationPrefs } from "@/lib/domain/notifications";
import { formatMoney } from "@/lib/format";

const col = () => adminDb().collection(activitiesCollectionPath());

const toActivity = (snap: DocumentSnapshot): Activity =>
  ({ id: snap.id, ...snap.data() }) as Activity;

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** "sábado 22 de noviembre a las 20:00" / "hoy" / "mañana a las 9:30". */
export const whenText = (a: Pick<Activity, "date" | "time">, today = todayYMD()) => {
  const day = dayLabel(a.date, today);
  const lower = day === "Hoy" || day === "Mañana" || day === "Ayer" ? day.toLowerCase() : `el ${day.charAt(0).toLowerCase()}${day.slice(1)}`;
  return a.time ? `${lower} a las ${a.time}` : lower;
};

const ownerName = (a: Activity) =>
  a.ownerDisplayName?.trim() || a.ownerEmail.split("@")[0] || "Alguien";

/**
 * Avisa a los invitados pendientes (o solo a los emails indicados). Los que
 * tienen cuenta reciben el aviso en la app (push / WhatsApp); a los que no, se
 * les manda un mail. Si un invitado ya tenía cuenta pero se lo cargó por email,
 * se completa su uid para que la vea en su agenda.
 */
export const inviteToActivity = async (
  activityId: string,
  onlyEmails?: string[],
): Promise<{ notified: number; emailed: number }> => {
  const ref = col().doc(activityId);
  const snap = await ref.get();
  if (!snap.exists) return { notified: 0, emailed: 0 };
  const activity = toActivity(snap);
  const filter = onlyEmails ? new Set(onlyEmails.map((e) => e.toLowerCase())) : null;
  const from = ownerName(activity);
  let notified = 0;
  let emailed = 0;
  let resolvedAny = false;

  const participants: ActivityParticipant[] = [];
  for (const p of activity.participants) {
    const target = p.status === "pending" && (!filter || filter.has(p.email.toLowerCase()));
    if (!target) {
      participants.push(p);
      continue;
    }
    let uid = p.uid;
    if (!uid) {
      const found = await adminDb().collection("users").where("email", "==", p.email.toLowerCase()).limit(1).get();
      if (!found.empty) {
        uid = found.docs[0].id;
        resolvedAny = true;
      }
    }
    participants.push({ ...p, uid });
    const when = whenText(activity);
    if (uid) {
      const r = await notify(uid, {
        kind: "agenda-invite",
        title: `${from} te invitó: ${activity.title}`,
        body: `${when.charAt(0).toUpperCase()}${when.slice(1)}${activity.location ? ` · ${activity.location}` : ""}. Entrá para decir si vas.`,
        url: "/agenda",
        whatsappText: `📅 *${from}* te invitó a *${activity.title}* ${when}${activity.location ? ` (${activity.location})` : ""}. Entrá a la agenda de la app para decir si vas.`,
        dedupeKey: `agenda-invite-${activity.id}`,
      });
      if (r.stored) notified += 1;
    } else {
      const { subject, html, text } = renderActivityInviteEmail({
        ownerName: from,
        ownerEmail: activity.ownerEmail,
        title: activity.title,
        when: `${when.charAt(0).toUpperCase()}${when.slice(1)}`,
        location: activity.location ?? null,
        notes: activity.notes ?? null,
        estimated:
          activity.estimatedAmount ? formatMoney(activity.estimatedAmount, activity.currency ?? "ARS") : null,
        appUrl: appUrl(),
      });
      const r = await sendEmail({ to: p.email, subject, html, text });
      if (r.ok) emailed += 1;
    }
  }

  if (resolvedAny) {
    await ref.update({ participants, ...activityIndexFields(participants), updatedAt: FieldValue.serverTimestamp() });
  }
  return { notified, emailed };
};

export class ActivityError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** El invitado acepta o rechaza (o se baja de una que ya había aceptado). */
export const respondToActivity = async (
  user: { uid: string; email: string | null },
  activityId: string,
  response: "accepted" | "rejected",
): Promise<void> => {
  const ref = col().doc(activityId);
  const email = user.email?.toLowerCase() ?? null;
  const result = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ActivityError("La actividad ya no existe", 404);
    const activity = toActivity(snap);
    let idx = activity.participants.findIndex((p) => p.uid === user.uid);
    if (idx === -1 && email) {
      idx = activity.participants.findIndex((p) => !p.uid && p.email.toLowerCase() === email);
    }
    if (idx === -1) throw new ActivityError("No estás invitado a esta actividad", 403);
    const me = activity.participants[idx];
    if (me.status === "owner") throw new ActivityError("Es tuya: no hace falta responder");
    if (me.status === response) return null;
    const participants = activity.participants.map((p, i) =>
      i === idx ? { ...p, uid: user.uid, status: response } : p,
    );
    tx.update(ref, { participants, ...activityIndexFields(participants), updatedAt: FieldValue.serverTimestamp() });
    return { activity, me: participants[idx], previous: me.status };
  });
  if (!result) return;

  const { activity, me, previous } = result;
  const who = participantName(me);
  const verb =
    response === "accepted" ? "va a" : previous === "accepted" ? "ya no va a" : "no puede ir a";
  await notify(activity.ownerUid, {
    kind: "agenda-response",
    title: `${who} ${verb} ${activity.title}`,
    body: whenText(activity).replace(/^./, (c) => c.toUpperCase()),
    url: "/agenda",
    whatsappText: `📅 *${who}* ${verb} *${activity.title}* (${whenText(activity)}).`,
    dedupeKey: `agenda-response-${activity.id}-${me.email}-${response}`,
  });
};

// === Cambios y cancelaciones (avisan a los invitados) ===

/** Los que se tienen que enterar: invitados que no dijeron que no. */
const audience = (a: Pick<Activity, "participants">) =>
  a.participants.filter((p) => p.status === "pending" || p.status === "accepted");

/**
 * Le avisa a un invitado: en la app (push / WhatsApp) si tiene cuenta, o por
 * mail si todavía no (le había llegado la invitación por mail).
 */
const tellParticipant = async (
  p: ActivityParticipant,
  msg: { kind: NotificationKind; title: string; body: string; whatsappText: string; dedupeKey: string },
  mail: { heading: string; lines: string[] },
): Promise<boolean> => {
  let uid = p.uid;
  if (!uid) {
    const found = await adminDb().collection("users").where("email", "==", p.email.toLowerCase()).limit(1).get();
    uid = found.docs[0]?.id ?? null;
  }
  try {
    if (uid) {
      const r = await notify(uid, { ...msg, url: "/agenda" });
      return r.stored;
    }
    const r = await sendEmail({
      to: p.email,
      ...renderActivityNoticeEmail({ subject: msg.title, heading: mail.heading, lines: mail.lines, appUrl: appUrl() }),
    });
    return r.ok;
  } catch (err) {
    console.warn("[agenda] no se pudo avisar a", p.email, err);
    return false;
  }
};

/** Qué cambió de lo que le importa a un invitado (día, hora, lugar, nombre). */
export const describeChanges = (before: Activity, after: Activity, today = todayYMD()): string[] => {
  const out: string[] = [];
  if (before.date !== after.date || (before.time ?? null) !== (after.time ?? null)) {
    out.push(`Ahora es ${whenText(after, today)} (antes: ${whenText(before, today)}).`);
  }
  if ((before.location ?? null) !== (after.location ?? null)) {
    out.push(after.location ? `Ahora es en ${after.location}.` : "Se sacó el lugar.");
  }
  if (before.title !== after.title) out.push(`Ahora se llama "${after.title}".`);
  return out;
};

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export interface UpdateResult {
  invited: number;
  notifiedChange: number;
  notifiedRemoved: number;
}

/**
 * El dueño edita la actividad. Se hace en el server para saber qué cambió:
 * a los nuevos les llega la invitación, a los que siguen invitados se les
 * avisa si cambió el día, la hora, el lugar o el nombre, y a los que sacó de
 * la lista se les avisa que ya no están.
 */
export const updateActivityAdmin = async (
  ownerUid: string,
  activityId: string,
  input: ActivityInput,
  invitees: Invitee[],
): Promise<UpdateResult> => {
  const ref = col().doc(activityId);
  const { before, after, added, removed } = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ActivityError("La actividad ya no existe", 404);
    const before = toActivity(snap);
    if (before.ownerUid !== ownerUid) throw new ActivityError("Solo quien la creó puede cambiarla", 403);
    const ownerP = before.participants.find((p) => p.status === "owner");
    const owner: Invitee & { uid: string } = {
      uid: ownerUid,
      email: ownerP?.email ?? before.ownerEmail,
      displayName: ownerP?.displayName ?? before.ownerDisplayName ?? null,
      photoURL: ownerP?.photoURL ?? null,
    };
    const { participants, added } = mergeParticipants(owner, before.participants, invitees);
    const kept = new Set(participants.map((p) => p.email.toLowerCase()));
    const removed = before.participants.filter((p) => p.status !== "owner" && !kept.has(p.email.toLowerCase()));
    const fields = { ...activityBaseFields(input), participants, ...activityIndexFields(participants) };
    tx.update(ref, { ...fields, updatedAt: FieldValue.serverTimestamp() });
    return { before, after: { ...before, ...fields } as Activity, added, removed };
  });

  const result: UpdateResult = { invited: 0, notifiedChange: 0, notifiedRemoved: 0 };
  const from = ownerName(after);

  if (added.length > 0) {
    const r = await inviteToActivity(activityId, added);
    result.invited = r.notified + r.emailed;
  }

  const changes = describeChanges(before, after);
  if (changes.length > 0) {
    const addedSet = new Set(added);
    const key = `agenda-change-${activityId}-${shortHash(`${after.title}|${after.date}|${after.time}|${after.location}`)}`;
    for (const p of audience(after)) {
      if (addedSet.has(p.email.toLowerCase())) continue;
      const ok = await tellParticipant(
        p,
        {
          kind: "agenda-changed",
          title: `Cambió: ${after.title}`,
          body: changes.join(" "),
          whatsappText: `📅 *${from}* cambió *${after.title}*. ${changes.join(" ")}`,
          dedupeKey: key,
        },
        { heading: `${from} cambió "${after.title}"`, lines: changes },
      );
      if (ok) result.notifiedChange += 1;
    }
  }

  for (const p of audience({ participants: removed })) {
    const ok = await tellParticipant(
      p,
      {
        kind: "agenda-cancelled",
        title: `Ya no estás en ${before.title}`,
        body: `${from} te sacó de la lista (era ${whenText(before)}).`,
        whatsappText: `📅 *${from}* te sacó de *${before.title}* (era ${whenText(before)}). Ya no figura en tu agenda.`,
        dedupeKey: `agenda-removed-${activityId}`,
      },
      {
        heading: `Ya no estás en "${before.title}"`,
        lines: [`${from} te sacó de la lista de invitados. Era ${whenText(before)}.`],
      },
    );
    if (ok) result.notifiedRemoved += 1;
  }
  return result;
};

/**
 * El dueño cancela la actividad: se borra y se les avisa a todos los
 * invitados que no habían dicho que no. Los gastos que hayan cargado siguen
 * en sus movimientos.
 */
export const cancelActivityAdmin = async (ownerUid: string, activityId: string): Promise<{ notified: number }> => {
  const ref = col().doc(activityId);
  const snap = await ref.get();
  if (!snap.exists) throw new ActivityError("La actividad ya no existe", 404);
  const a = toActivity(snap);
  if (a.ownerUid !== ownerUid) throw new ActivityError("Solo quien la creó puede cancelarla", 403);
  await ref.delete();

  const from = ownerName(a);
  const when = whenText(a);
  let notified = 0;
  // Si ya pasó, no tiene sentido avisar que "se canceló".
  if (a.date < todayYMD()) return { notified };
  for (const p of audience(a)) {
    const hadExpense = p.uid ? !!a.expenses?.[p.uid] : false;
    const extra = hadExpense ? " El gasto que cargaste sigue en tus movimientos." : "";
    const ok = await tellParticipant(
      p,
      {
        kind: "agenda-cancelled",
        title: `Se canceló: ${a.title}`,
        body: `${from} la canceló (era ${when}).${extra}`,
        whatsappText: `❌ *${from}* canceló *${a.title}* (${when}).${extra}`,
        dedupeKey: `agenda-cancel-${activityId}`,
      },
      {
        heading: `Se canceló "${a.title}"`,
        lines: [`${from} la canceló. Era ${when}${a.location ? `, en ${a.location}` : ""}.`],
      },
    );
    if (ok) notified += 1;
  }
  return { notified };
};

// === Para el agente de WhatsApp ===

/** Crea una actividad (con invitados ya resueltos) y les avisa. */
export const createActivityAdmin = async (
  owner: Invitee & { uid: string },
  input: ActivityInput,
  invitees: Invitee[],
): Promise<Activity> => {
  const { participants } = mergeParticipants(owner, [], invitees);
  const ref = col().doc();
  const data = {
    ownerUid: owner.uid,
    ownerEmail: owner.email.toLowerCase(),
    ownerDisplayName: owner.displayName ?? null,
    ...activityBaseFields(input),
    participants,
    ...activityIndexFields(participants),
    expenses: {},
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(data);
  if (participants.length > 1) await inviteToActivity(ref.id);
  return { id: ref.id, ...data } as unknown as Activity;
};

/** Actividades del usuario entre dos fechas (incluidas), sin las que rechazó. */
export const listAgenda = async (uid: string, from: string, to: string): Promise<Activity[]> => {
  const snap = await col().where("participantUids", "array-contains", uid).get();
  return snap.docs
    .map(toActivity)
    .filter((a) => a.date >= from && a.date <= to)
    .filter((a) => a.participants.find((p) => p.uid === uid)?.status !== "rejected")
    .sort(compareActivities);
};

// === Aviso de la mañana ===

const goingStatuses = new Set(["owner", "accepted"]);

/**
 * Le manda a cada usuario lo que tiene hoy en la agenda (las suyas y las
 * compartidas que aceptó). Una consulta para todos: las actividades de hoy.
 */
export const agendaReminders = async (
  today: string,
  prefsOf: (uid: string) => NotificationPrefs | null,
): Promise<number> => {
  const snap = await col().where("date", "==", today).get();
  const byUser = new Map<string, Activity[]>();
  for (const doc of snap.docs) {
    const a = toActivity(doc);
    for (const p of a.participants) {
      if (!p.uid || !goingStatuses.has(p.status)) continue;
      const list = byUser.get(p.uid) ?? [];
      list.push(a);
      byUser.set(p.uid, list);
    }
  }

  let sent = 0;
  for (const [uid, list] of byUser) {
    const prefs = prefsOf(uid);
    if (!prefs?.agenda) continue;
    list.sort(compareActivities);
    const line = (a: Activity) => {
      const others = a.participants
        .filter((p) => p.uid !== uid && goingStatuses.has(p.status))
        .map(participantName);
      return `${a.time ? `${a.time} ` : ""}${a.title}${others.length ? ` (con ${others.join(", ")})` : ""}`;
    };
    const title =
      list.length === 1
        ? `Hoy: ${list[0].title}${list[0].time ? ` a las ${list[0].time}` : ""}`
        : `Hoy tenés ${list.length} cosas en la agenda`;
    const body = list.length === 1 ? (list[0].location ?? line(list[0])) : list.map(line).join(" · ");
    try {
      const r = await notify(uid, {
        kind: "agenda-today",
        title,
        body,
        url: "/agenda",
        whatsappText: `📅 *Tu agenda de hoy*\n${list.map((a) => `• ${line(a)}`).join("\n")}`,
        dedupeKey: `agenda-${today}`,
      });
      if (r.stored) sent += 1;
    } catch (err) {
      console.error("[cron] agenda de", uid, err);
    }
  }
  return sent;
};

/**
 * Se borró un movimiento desde el server (ej. al cancelar un reparto con
 * "borrar el gasto"): si era el gasto de una actividad, sale de la actividad.
 */
export const unlinkActivityTransactionAdmin = async (uid: string, transactionId: string): Promise<void> => {
  try {
    const linkRef = adminDb().doc(`${activityLinksCollectionPath(uid)}/${transactionId}`);
    const linkSnap = await linkRef.get();
    if (!linkSnap.exists) return;
    const { activityId } = linkSnap.data() as ActivityLink;
    const snap = await col().doc(activityId).get();
    const current = snap.exists ? (snap.data() as Omit<Activity, "id">).expenses?.[uid] : undefined;
    if (current?.transactionId === transactionId) {
      await col()
        .doc(activityId)
        .update({ [`expenses.${uid}`]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    }
    await linkRef.delete();
  } catch (err) {
    console.warn("[agenda] no se pudo sacar el gasto de la actividad", err);
  }
};
