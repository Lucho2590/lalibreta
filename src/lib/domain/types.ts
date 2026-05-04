import type { Timestamp } from "firebase/firestore";

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Contact {
  id: string;
  email: string;
  displayName?: string | null;
  linkedUid?: string | null;
  photoURL?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export type ShareParticipantStatus =
  | "owner"
  | "pending"
  | "accepted"
  | "rejected";

export interface ShareParticipant {
  uid: string | null;
  email: string;
  displayName?: string | null;
  percentage: number;
  amount: number;
  status: ShareParticipantStatus;
  respondedAt?: Timestamp | null;
}

export type SharedExpenseStatus = "active" | "cancelled";

export interface SharedExpense {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  ownerDisplayName?: string | null;
  description: string;
  totalAmount: number;
  date: Timestamp;
  ownerTransactionId?: string;
  participants: ShareParticipant[];
  participantUids: string[];
  participantEmails: string[];
  status: SharedExpenseStatus;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export type AccountType =
  | "cash"
  | "debit"
  | "credit"
  | "checking"
  | "savings"
  | "digital";

export type TransactionKind = "expense" | "income" | "transfer";

export type CategoryKind = "expense" | "income";

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: CategoryKind;
  createdAt: Timestamp;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  icon?: string;
  color?: string;
  parentId?: string | null;
  active?: boolean;
  defaultClosingDay?: number;
  defaultDueDay?: number;
  createdAt: Timestamp;
}

export interface CardCycle {
  id: string;
  year: number;
  month: number;
  closingDate: Timestamp;
  dueDate: Timestamp;
}

export interface Transaction {
  id: string;
  accountId: string;
  categoryId: string;
  description: string;
  totalAmount: number;
  purchaseDate: Timestamp;
  kind: TransactionKind;
  installments: number;
  cardClosedAtPurchase?: boolean;
  firstBillingMonth?: string;
  recurringId?: string;
  toAccountId?: string;
  createdAt: Timestamp;
}

export interface RecurringExpense {
  id: string;
  name: string;
  amount: number;
  accountId: string;
  categoryId: string;
  kind: TransactionKind;
  dayOfMonth: number;
  startMonth: string;
  endMonth?: string | null;
  active: boolean;
  createdAt: Timestamp;
}

export interface Installment {
  id: string;
  transactionId: string;
  accountId: string;
  categoryId: string;
  amount: number;
  billingMonth: string;
  billingDate: Timestamp;
  installmentNumber: number;
  totalInstallments: number;
  kind: TransactionKind;
  description: string;
  recurringId?: string;
  transferRole?: "source" | "destination";
  transferCounterpartId?: string;
}

export const monthKey = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, "0")}`;

export const parseMonthKey = (key: string): { year: number; month: number } => {
  const [y, m] = key.split("-").map(Number);
  return { year: y, month: m };
};
