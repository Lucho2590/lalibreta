import "server-only";

import { adminDb } from "../firebase-admin";
import type { ChatTurn, Draft, WhatsappSession } from "./types";

/**
 * Estado de conversación por número: historial corto (para que el agente
 * entienda "no, con la visa") y el borrador pendiente de confirmación.
 */

const SESSIONS = "whatsappSessions";
const MAX_TURNS = 12;
const SESSION_IDLE_MS = 30 * 60 * 1000;
export const DRAFT_TTL_MS = 30 * 60 * 1000;

const ref = (waId: string) => adminDb().collection(SESSIONS).doc(waId);

export const loadSession = async (
  waId: string,
  uid: string,
): Promise<WhatsappSession> => {
  const snap = await ref(waId).get();
  const empty: WhatsappSession = {
    uid,
    history: [],
    pendingDraft: null,
    updatedAt: Date.now(),
  };
  if (!snap.exists) return empty;
  const data = snap.data() as WhatsappSession;
  // La sesión es de otro usuario (re-vinculación) o quedó vieja: arrancamos de cero.
  if (data.uid !== uid) return empty;
  if (Date.now() - (data.updatedAt ?? 0) > SESSION_IDLE_MS) return empty;
  const draft =
    data.pendingDraft && Date.now() - data.pendingDraft.createdAt <= DRAFT_TTL_MS
      ? data.pendingDraft
      : null;
  return { ...data, history: data.history ?? [], pendingDraft: draft };
};

export const saveSession = async (
  waId: string,
  session: WhatsappSession,
  newTurns: ChatTurn[],
) => {
  const history = [...session.history, ...newTurns].slice(-MAX_TURNS);
  await ref(waId).set({
    uid: session.uid,
    history,
    pendingDraft: session.pendingDraft,
    updatedAt: Date.now(),
  });
};

/**
 * Toma el borrador de forma atómica (lo saca de la sesión) para que dos
 * toques seguidos a "Confirmar" no creen el movimiento dos veces.
 * Si draftId es null, toma el borrador vigente sea cual sea.
 */
export const takeDraft = async (
  waId: string,
  uid: string,
  draftId: string | null,
): Promise<Draft | null> => {
  const db = adminDb();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(waId));
    if (!snap.exists) return null;
    const data = snap.data() as WhatsappSession;
    const draft = data.pendingDraft;
    if (data.uid !== uid || !draft) return null;
    if (draftId && draft.id !== draftId) return null;
    tx.update(ref(waId), { pendingDraft: null, updatedAt: Date.now() });
    if (Date.now() - draft.createdAt > DRAFT_TTL_MS) return null;
    return draft;
  });
};
