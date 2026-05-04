import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { ShareParticipant, SharedExpense } from "./types";

export const sharedExpensesCollectionPath = (): string => "sharedExpenses";

export interface CreateSharedExpenseInput {
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName?: string | null;
  description: string;
  totalAmount: number;
  date: Date;
  ownerTransactionId?: string;
  participants: ShareParticipant[];
}

export const createSharedExpense = async (
  input: CreateSharedExpenseInput,
): Promise<string> => {
  const participantUids = Array.from(
    new Set(
      input.participants
        .map((p) => p.uid)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  );
  const participantEmails = Array.from(
    new Set(input.participants.map((p) => p.email.toLowerCase())),
  );

  const data: Omit<SharedExpense, "id"> = {
    ownerUid: input.ownerUid,
    ownerEmail: input.ownerEmail.toLowerCase(),
    ownerDisplayName: input.ownerDisplayName ?? null,
    description: input.description,
    totalAmount: input.totalAmount,
    date: Timestamp.fromDate(input.date),
    ...(input.ownerTransactionId
      ? { ownerTransactionId: input.ownerTransactionId }
      : {}),
    participants: input.participants,
    participantUids,
    participantEmails,
    status: "active",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };

  const ref = await addDoc(collection(db, sharedExpensesCollectionPath()), data);
  return ref.id;
};

export const cancelSharedExpense = async (id: string): Promise<void> => {
  await updateDoc(doc(db, `${sharedExpensesCollectionPath()}/${id}`), {
    status: "cancelled",
    updatedAt: Timestamp.now(),
  });
};

export const deleteSharedExpense = async (id: string): Promise<void> => {
  await deleteDoc(doc(db, `${sharedExpensesCollectionPath()}/${id}`));
};

/**
 * Construye la lista normalizada de participantes a partir del input del form.
 * Garantiza que el owner está incluido como primer item con status="owner".
 */
export const buildParticipantsList = (params: {
  owner: { uid: string; email: string; displayName?: string | null; percentage: number };
  others: Array<{
    uid: string | null;
    email: string;
    displayName?: string | null;
    percentage: number;
  }>;
  totalAmount: number;
}): ShareParticipant[] => {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const ownerEntry: ShareParticipant = {
    uid: params.owner.uid,
    email: params.owner.email.toLowerCase(),
    displayName: params.owner.displayName ?? null,
    percentage: params.owner.percentage,
    amount: round2((params.totalAmount * params.owner.percentage) / 100),
    status: "owner",
  };
  const others = params.others.map<ShareParticipant>((p) => ({
    uid: p.uid,
    email: p.email.toLowerCase(),
    displayName: p.displayName ?? null,
    percentage: p.percentage,
    amount: round2((params.totalAmount * p.percentage) / 100),
    status: "pending",
  }));
  return [ownerEntry, ...others];
};
