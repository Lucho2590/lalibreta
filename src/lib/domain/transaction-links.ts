import { syncActivityLinkForTransaction } from "./activities";
import { syncListLinkForTransaction } from "./lists";
import type { Currency } from "./types";

/**
 * Un movimiento se editó o se borró: actualiza lo que lo tenía vinculado (el
 * ítem de una lista, la actividad de la agenda). Nunca tira error.
 */
export const syncTransactionLinks = async (
  uid: string,
  transactionId: string,
  change: { deleted: true } | { deleted?: false; amount: number; currency: Currency },
): Promise<void> => {
  await Promise.all([
    syncListLinkForTransaction(uid, transactionId, change),
    syncActivityLinkForTransaction(uid, transactionId, change),
  ]);
};
