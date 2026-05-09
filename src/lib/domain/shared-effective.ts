import type { Installment, SharedExpense } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface EffectiveShareInfo {
  isShared: boolean;
  shared?: SharedExpense;
  totalAmount: number;
  effectiveAmount: number;
  acceptedCount: number;
  pendingCount: number;
  rejectedCount: number;
  othersCount: number;
}

export const buildSharedByTxId = (
  shared: SharedExpense[],
): Map<string, SharedExpense> => {
  const map = new Map<string, SharedExpense>();
  for (const s of shared) {
    if (s.ownerTransactionId) map.set(s.ownerTransactionId, s);
  }
  return map;
};

const sumAcceptedFromOthers = (
  shared: SharedExpense,
  ownerUid: string,
): number => {
  let acc = 0;
  for (const p of shared.participants) {
    if (p.uid === ownerUid) continue;
    if (p.status === "accepted") acc += p.amount;
  }
  return acc;
};

export const getEffectiveInstallmentInfo = (
  installment: Installment,
  sharedByTxId: Map<string, SharedExpense>,
  ownerUid: string,
): EffectiveShareInfo => {
  const shared = sharedByTxId.get(installment.transactionId);
  const total = installment.amount;
  if (!shared || shared.status === "cancelled") {
    return {
      isShared: false,
      totalAmount: total,
      effectiveAmount: total,
      acceptedCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
      othersCount: 0,
    };
  }
  const acceptedSum = sumAcceptedFromOthers(shared, ownerUid);
  const T = shared.totalAmount;
  const factor = T > 0 ? Math.max(0, (T - acceptedSum) / T) : 1;
  let accepted = 0;
  let pending = 0;
  let rejected = 0;
  let others = 0;
  for (const p of shared.participants) {
    if (p.uid === ownerUid) continue;
    others += 1;
    if (p.status === "accepted") accepted += 1;
    else if (p.status === "pending") pending += 1;
    else if (p.status === "rejected") rejected += 1;
  }
  return {
    isShared: true,
    shared,
    totalAmount: total,
    effectiveAmount: round2(total * factor),
    acceptedCount: accepted,
    pendingCount: pending,
    rejectedCount: rejected,
    othersCount: others,
  };
};
