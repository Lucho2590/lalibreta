import "server-only";

import { requestConnectionTo } from "./connections";
import { notify } from "./notifications";
import { linkMember, loadVaquita, pendingLinksCol, type PendingLink } from "./vaquitas";
import { phoneVariants } from "@/lib/domain/phone";
import { firstName } from "@/lib/domain/vaquitas";

/**
 * Integrantes "sin la app" que quedaron para vincular solos (ver
 * vaquitaLinks en lib/server/vaquitas.ts):
 * - le mandamos la solicitud → cuando la acepta, se vincula;
 * - lo invitamos por email o WhatsApp → cuando se registra con ese email o
 *   vincula ese WhatsApp, le llega la solicitud de quien lo sumó (y se
 *   vincula cuando la acepta).
 * Nada de esto tiene que romper el flujo que lo dispara: los errores se
 * registran y listo.
 */

type Doc = FirebaseFirestore.QueryDocumentSnapshot;
const data = (d: Doc) => d.data() as PendingLink;

const tryLink = async (p: PendingLink, uid: string) => {
  try {
    await linkMember({ uid: p.byUid }, { id: p.vaquitaId, memberId: p.memberId, ref: `u:${uid}` });
  } catch (err) {
    // La vaquita, el integrante o quien lo sumó ya no están, o ya se vinculó.
    console.warn("[vaquita-links] no se pudo vincular", p.vaquitaId, p.memberId, err);
  }
};

/** Se conectaron `a` y `b`: los integrantes que cada uno dejó pendientes para el otro quedan vinculados. */
export const resolveLinksForConnection = async (a: string, b: string): Promise<void> => {
  try {
    for (const [by, other] of [
      [a, b],
      [b, a],
    ]) {
      const snap = await pendingLinksCol().where("kind", "==", "uid").where("value", "==", other).where("byUid", "==", by).get();
      for (const d of snap.docs) {
        await tryLink(data(d), other);
        await d.ref.delete().catch(() => {});
      }
    }
  } catch (err) {
    console.warn("[vaquita-links] resolveLinksForConnection", err);
  }
};

/**
 * Apareció en La Libreta alguien que habían invitado (se registró con ese
 * email o vinculó ese WhatsApp): le llega la solicitud de quien lo sumó y
 * queda pendiente de que la acepte.
 */
export const resolveLinksForNewIdentity = async (uid: string, who: { email?: string | null; waId?: string | null }) => {
  try {
    const docs: Doc[] = [];
    if (who.email) {
      docs.push(...(await pendingLinksCol().where("kind", "==", "email").where("value", "==", who.email.trim().toLowerCase()).get()).docs);
    }
    if (who.waId) {
      docs.push(...(await pendingLinksCol().where("kind", "==", "phone").where("value", "in", phoneVariants(who.waId).slice(0, 10)).get()).docs);
    }
    for (const d of docs) {
      const p = data(d);
      if (p.byUid === uid) {
        await d.ref.delete().catch(() => {});
        continue;
      }
      try {
        const r = await requestConnectionTo({ uid: p.byUid }, uid);
        if (r.status === "accepted") {
          await tryLink(p, uid);
          await d.ref.delete().catch(() => {});
          continue;
        }
        await d.ref.update({ kind: "uid", value: uid });
        const v = await loadVaquita(p.vaquitaId);
        const by = v.members.find((m) => m.uid === p.byUid)?.name ?? "Alguien";
        await notify(uid, {
          kind: "vaquita-invite",
          title: `${firstName(by)} te sumó a la vaquita «${v.name}»`,
          body: "Aceptá su solicitud en Contactos y la ves con todos sus gastos.",
          url: "/contactos",
          whatsappText: `🐮 *${firstName(by)}* te sumó a la vaquita *${v.name}*. Aceptá su solicitud en Contactos (en La Libreta) y la ves con todos los gastos.`,
        });
      } catch (err) {
        console.warn("[vaquita-links] resolveLinksForNewIdentity", p.vaquitaId, p.memberId, err);
      }
    }
  } catch (err) {
    console.warn("[vaquita-links] resolveLinksForNewIdentity", err);
  }
};
