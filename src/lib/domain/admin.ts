import type { AiFeature, AiUsageBucket } from "./ai-pricing";

/** Lo que devuelve GET /api/admin/overview. */

export interface AdminUserRow {
  uid: string;
  email: string | null;
  name: string | null;
  photoURL: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
  agentName: string | null;
  whatsapp: Array<{ waId: string; profileName: string | null; linkedAt: string | null; lastMessageAt: string | null }>;
  devices: number;
  accounts: number;
  transactions: number;
  ai: { thisMonth: AiUsageBucket; lastMonth: AiUsageBucket; total: AiUsageBucket };
}

export interface AdminOverview {
  generatedAt: string;
  month: string;
  lastMonth: string;
  usdRate: number | null;
  users: AdminUserRow[];
  totals: { thisMonth: AiUsageBucket; lastMonth: AiUsageBucket; total: AiUsageBucket };
  thisMonthByFeature: Partial<Record<AiFeature, AiUsageBucket>>;
  thisMonthByModel: Record<string, AiUsageBucket>;
  /** Últimos meses (para ver la tendencia). */
  byMonth: Array<{ month: string } & AiUsageBucket>;
  agentNames: string[];
}

export type AdminAction = "reset-memory" | "new-agent" | "unlink-whatsapp";
