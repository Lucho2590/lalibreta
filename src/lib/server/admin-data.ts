import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebase-admin";
import { getUsdRate } from "./fx";
import { AGENT_PERSONAS } from "./onboarding";
import { currentMonthKey } from "./time";
import { unlinkUser } from "./whatsapp/linking";
import type { AiFeature, AiUsageBucket } from "@/lib/domain/ai-pricing";
import type { AdminAction, AdminOverview, AdminUserRow } from "@/lib/domain/admin";

const emptyBucket = (): AiUsageBucket => ({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 });

const addInto = (into: AiUsageBucket, b: Partial<AiUsageBucket> | undefined) => {
  if (!b) return;
  into.calls += b.calls ?? 0;
  into.inputTokens += b.inputTokens ?? 0;
  into.cachedTokens += b.cachedTokens ?? 0;
  into.outputTokens += b.outputTokens ?? 0;
  into.costUsd += b.costUsd ?? 0;
};

const prevMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

const iso = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  if (typeof (v as Timestamp).toDate === "function") return (v as Timestamp).toDate().toISOString();
  return null;
};

export const loadAdminOverview = async (): Promise<AdminOverview> => {
  const db = adminDb();
  const month = currentMonthKey();
  const lastMonth = prevMonth(month);

  const [authUsers, userDocs, links, usage, fx] = await Promise.all([
    adminAuth().listUsers(1000),
    db.collection("users").get(),
    db.collection("whatsappLinks").get(),
    db.collection("aiUsage").get(),
    getUsdRate().catch(() => null),
  ]);

  const profile = new Map(userDocs.docs.map((d) => [d.id, d.data()]));
  const sessions = links.empty
    ? []
    : await db.getAll(...links.docs.map((l) => db.collection("whatsappSessions").doc(l.id)));
  const lastMsg = new Map(sessions.map((s) => [s.id, s.data()?.updatedAt as number | undefined]));

  const totals = { thisMonth: emptyBucket(), lastMonth: emptyBucket(), total: emptyBucket() };
  const perUser = new Map<string, AdminUserRow["ai"]>();
  const byFeature: Partial<Record<AiFeature, AiUsageBucket>> = {};
  const byModel: Record<string, AiUsageBucket> = {};
  const byMonth = new Map<string, AiUsageBucket>();
  for (const d of usage.docs) {
    const u = d.data();
    const uid = u.uid as string;
    const m = u.month as string;
    if (!perUser.has(uid)) perUser.set(uid, { thisMonth: emptyBucket(), lastMonth: emptyBucket(), total: emptyBucket() });
    const row = perUser.get(uid)!;
    addInto(row.total, u);
    addInto(totals.total, u);
    if (!byMonth.has(m)) byMonth.set(m, emptyBucket());
    addInto(byMonth.get(m)!, u);
    if (m === month) {
      addInto(row.thisMonth, u);
      addInto(totals.thisMonth, u);
      for (const [k, b] of Object.entries((u.byFeature ?? {}) as Record<string, AiUsageBucket>)) {
        byFeature[k as AiFeature] ??= emptyBucket();
        addInto(byFeature[k as AiFeature]!, b);
      }
      for (const [k, b] of Object.entries((u.byModel ?? {}) as Record<string, AiUsageBucket>)) {
        const name = k.replace(/_/g, ".");
        byModel[name] ??= emptyBucket();
        addInto(byModel[name], b);
      }
    }
    if (m === lastMonth) {
      addInto(row.lastMonth, u);
      addInto(totals.lastMonth, u);
    }
  }

  const users: AdminUserRow[] = await Promise.all(
    authUsers.users.map(async (u) => {
      const p = profile.get(u.uid) ?? {};
      const userRef = db.collection("users").doc(u.uid);
      const [accounts, transactions, devices] = await Promise.all([
        userRef.collection("accounts").count().get(),
        userRef.collection("transactions").count().get(),
        userRef.collection("pushSubscriptions").count().get(),
      ]);
      return {
        uid: u.uid,
        email: u.email ?? null,
        name: u.displayName ?? (p.displayName as string | undefined) ?? null,
        photoURL: u.photoURL ?? null,
        createdAt: iso(u.metadata.creationTime),
        lastSignInAt: iso(u.metadata.lastRefreshTime ?? u.metadata.lastSignInTime),
        agentName: (p.agentName as string | undefined) ?? null,
        whatsapp: links.docs
          .filter((l) => l.data().uid === u.uid)
          .map((l) => ({
            waId: l.id,
            profileName: (l.data().profileName as string | undefined) ?? null,
            linkedAt: iso(l.data().linkedAt),
            lastMessageAt: iso(lastMsg.get(l.id)),
          })),
        devices: devices.data().count,
        accounts: accounts.data().count,
        transactions: transactions.data().count,
        ai: perUser.get(u.uid) ?? { thisMonth: emptyBucket(), lastMonth: emptyBucket(), total: emptyBucket() },
      };
    }),
  );
  users.sort((a, b) => b.ai.thisMonth.costUsd - a.ai.thisMonth.costUsd || (b.lastSignInAt ?? "").localeCompare(a.lastSignInAt ?? ""));

  return {
    generatedAt: new Date().toISOString(),
    month,
    lastMonth,
    usdRate: fx?.rate ?? null,
    users,
    totals,
    thisMonthByFeature: byFeature,
    thisMonthByModel: byModel,
    byMonth: [...byMonth.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 6)
      .map(([m, b]) => ({ month: m, ...b })),
    agentNames: AGENT_PERSONAS.map((p) => p.name),
  };
};

/** Borra la conversación (historial y borrador pendiente) del agente del usuario. */
const resetMemory = async (uid: string): Promise<number> => {
  const db = adminDb();
  const links = await db.collection("whatsappLinks").where("uid", "==", uid).get();
  await Promise.all(links.docs.map((l) => db.collection("whatsappSessions").doc(l.id).delete()));
  return links.size;
};

export const runAdminAction = async (
  uid: string,
  action: AdminAction,
  agentName?: string,
): Promise<{ ok: true; message: string }> => {
  await adminAuth().getUser(uid); // 404 si no existe
  switch (action) {
    case "reset-memory": {
      const n = await resetMemory(uid);
      return { ok: true, message: n ? "Listo: el agente arranca la charla de cero." : "No tenía WhatsApp vinculado." };
    }
    case "new-agent": {
      const ref = adminDb().collection("users").doc(uid);
      const current = (await ref.get()).data()?.agentName as string | undefined;
      const options = AGENT_PERSONAS.map((p) => p.name).filter((n) => n !== current);
      const name = agentName && AGENT_PERSONAS.some((p) => p.name === agentName)
        ? agentName
        : options[Math.floor(Math.random() * options.length)];
      await ref.set({ agentName: name, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      // Sin la charla vieja, para que no siga hablando como el personaje anterior.
      await resetMemory(uid);
      return { ok: true, message: `Nuevo agente: ${name}.` };
    }
    case "unlink-whatsapp": {
      const n = await unlinkUser(uid);
      return { ok: true, message: n ? "WhatsApp desvinculado." : "No tenía WhatsApp vinculado." };
    }
  }
};
