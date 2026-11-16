"use client";

import { useMemo } from "react";
import {
  collection,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuth } from "./use-auth";
import { useCollection } from "./use-collection";
import type {
  Account,
  AccountShare,
  Category,
  Contact,
  Installment,
  PendingApproval,
  RecurringExpense,
  SharedExpense,
  Transaction,
} from "@/lib/domain/types";
import type { AppNotification } from "@/lib/domain/notifications";
import {
  categoriesCollectionPath,
} from "@/lib/domain/seed";
import {
  installmentsCollectionPath,
  transactionsCollectionPath,
} from "@/lib/domain/installments";
import { recurringCollectionPath } from "@/lib/domain/recurring";
import { contactsCollectionPath } from "@/lib/domain/contacts";
import { sharedExpensesCollectionPath } from "@/lib/domain/shared";
import {
  activitiesCollectionPath,
  compareActivities,
  type Activity,
} from "@/lib/domain/activities";

const accountsCollectionPath = (uid: string) => `users/${uid}/accounts`;

export function useAccounts() {
  const { user } = useAuth();
  const q = useMemo(
    () => (user ? query(collection(db, accountsCollectionPath(user.uid)), orderBy("createdAt", "asc")) : null),
    [user],
  );
  return useCollection<Account>(q);
}

export function useCategories() {
  const { user } = useAuth();
  const q = useMemo(
    () => (user ? query(collection(db, categoriesCollectionPath(user.uid)), orderBy("name", "asc")) : null),
    [user],
  );
  return useCollection<Category>(q);
}

export function useInstallmentsForMonth(monthKey: string) {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, installmentsCollectionPath(user.uid)),
            // Mes de pago: las tarjetas aparecen en el mes en que vence el resumen.
            where("paymentMonth", "==", monthKey),
          )
        : null,
    [user, monthKey],
  );
  return useCollection<Installment>(q);
}

export function useAllInstallments() {
  const { user } = useAuth();
  const q = useMemo(
    () => (user ? query(collection(db, installmentsCollectionPath(user.uid))) : null),
    [user],
  );
  return useCollection<Installment>(q);
}

export function useRecurring() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, recurringCollectionPath(user.uid)),
            orderBy("createdAt", "desc"),
          )
        : null,
    [user],
  );
  return useCollection<RecurringExpense>(q);
}

export function useContacts() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, contactsCollectionPath(user.uid)),
            orderBy("createdAt", "desc"),
          )
        : null,
    [user],
  );
  return useCollection<Contact>(q);
}

export function useSharedAsOwner() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, sharedExpensesCollectionPath()),
            where("ownerUid", "==", user.uid),
          )
        : null,
    [user],
  );
  return useCollection<SharedExpense>(q);
}

export function useSharedAsParticipant() {
  const { user } = useAuth();
  const email = user?.email?.toLowerCase() ?? null;
  const q = useMemo(
    () =>
      email
        ? query(
            collection(db, sharedExpensesCollectionPath()),
            where("participantEmails", "array-contains", email),
          )
        : null,
    [email],
  );
  return useCollection<SharedExpense>(q);
}

export function useAccountSharesAsOwner() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, "accountShares"),
            where("ownerUid", "==", user.uid),
            orderBy("createdAt", "desc"),
          )
        : null,
    [user],
  );
  return useCollection<AccountShare>(q);
}

export function useAccountSharesAsGrantee() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, "accountShares"),
            where("granteeUid", "==", user.uid),
            where("status", "==", "active"),
          )
        : null,
    [user],
  );
  return useCollection<AccountShare>(q);
}

export function usePendingApprovalsAsOwner() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, "pendingApprovals"),
            where("ownerUid", "==", user.uid),
            where("status", "==", "pending"),
          )
        : null,
    [user],
  );
  return useCollection<PendingApproval>(q);
}

export function useApprovalsAsGrantee() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, "pendingApprovals"),
            where("granteeUid", "==", user.uid),
            orderBy("createdAt", "desc"),
          )
        : null,
    [user],
  );
  return useCollection<PendingApproval>(q);
}

export function useTransactions() {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(
            collection(db, transactionsCollectionPath(user.uid)),
            orderBy("createdAt", "desc"),
          )
        : null,
    [user],
  );
  return useCollection<Transaction>(q);
}

export function useNotifications(max = 60) {
  const { user } = useAuth();
  const q = useMemo(
    () =>
      user
        ? query(collection(db, `users/${user.uid}/notifications`), orderBy("createdAt", "desc"), limit(max))
        : null,
    [user, max],
  );
  return useCollection<AppNotification>(q);
}

/**
 * Agenda: las actividades donde participo (mías o a las que me invitaron).
 * Dos consultas: por uid, y por email para las invitaciones que llegaron
 * antes de que el invitado tuviera cuenta.
 */
export function useActivities() {
  const { user } = useAuth();
  const email = user?.email?.toLowerCase() ?? null;
  const byUid = useMemo(
    () =>
      user
        ? query(collection(db, activitiesCollectionPath()), where("participantUids", "array-contains", user.uid))
        : null,
    [user],
  );
  const byEmail = useMemo(
    () =>
      email
        ? query(collection(db, activitiesCollectionPath()), where("participantEmails", "array-contains", email))
        : null,
    [email],
  );
  const a = useCollection<Activity>(byUid);
  const b = useCollection<Activity>(byEmail);
  const data = useMemo(() => {
    const map = new Map<string, Activity>();
    for (const x of [...a.data, ...b.data]) map.set(x.id, x);
    return [...map.values()].sort(compareActivities);
  }, [a.data, b.data]);
  return { data, loading: a.loading || b.loading, error: a.error ?? b.error };
}
