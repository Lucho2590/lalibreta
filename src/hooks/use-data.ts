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
  Transaction,
} from "@/lib/domain/types";
import {
  contactRef,
  otherUid,
  profileName,
  userRef,
  type Connection,
  type PersonRef,
  type PersonTransfer,
  type Split,
} from "@/lib/domain/people";
import { buildSplitAdjustment, computePeopleLedger } from "@/lib/domain/debts";
import type { SharedAdjustment } from "@/lib/domain/balance";
import { paymentMonthOf } from "@/lib/domain/types";
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
import { contactDisplayName, type PayAlias } from "@/lib/domain/contact-info";
import {
  activitiesCollectionPath,
  compareActivities,
  type Activity,
} from "@/lib/domain/activities";
import { listsCollectionPath, type ListNode } from "@/lib/domain/list-model";

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

// === Cuentas con gente ===

/** Conexiones donde estoy (pendientes, aceptadas, rechazadas…). */
export function useConnections() {
  const { user } = useAuth();
  const q = useMemo(
    () => (user ? query(collection(db, "connections"), where("uids", "array-contains", user.uid)) : null),
    [user],
  );
  return useCollection<Connection>(q);
}

/** Gastos repartidos donde participo (como dueño o como participante). */
export function useSplits() {
  const { user } = useAuth();
  const q = useMemo(
    () => (user ? query(collection(db, "splits"), where("uids", "array-contains", user.uid)) : null),
    [user],
  );
  return useCollection<Split>(q);
}

export interface SplitRuleDoc {
  id: string;
  key: string;
  label: string;
  participants: Array<{ ref: PersonRef; shareType: "percent" | "amount"; value: number; name: string }>;
  mode: "installments" | "lump";
}

/** "Dividir siempre": comercios que se dividen solos. */
export function useSplitRules() {
  const { user } = useAuth();
  const q = useMemo(() => (user ? query(collection(db, `users/${user.uid}/splitRules`)) : null), [user]);
  return useCollection<SplitRuleDoc>(q);
}

/** Transferencias con personas donde participo. */
export function usePersonTransfers() {
  const { user } = useAuth();
  const q = useMemo(
    () => (user ? query(collection(db, "p2pTransfers"), where("uids", "array-contains", user.uid)) : null),
    [user],
  );
  return useCollection<PersonTransfer>(q);
}

export interface PersonOption {
  ref: PersonRef;
  name: string;
  /** Usa la app (conexión aceptada) o es un contacto sin app. */
  isApp: boolean;
  email: string | null;
  /** Su doc en users/{yo}/contacts (los conectados viejos pueden no tenerlo). */
  contactId: string | null;
  nicknames: string[];
  payAliases: PayAlias[];
}

/** Con quién puedo repartir / transferir: conexiones aceptadas + contactos sin app. */
export function usePeople() {
  const { user } = useAuth();
  const { data: connections, loading: l1 } = useConnections();
  const { data: contacts, loading: l2 } = useContacts();
  const people = useMemo<PersonOption[]>(() => {
    if (!user) return [];
    const out: PersonOption[] = [];
    const byUid = new Map(contacts.filter((c) => c.linkedUid).map((c) => [c.linkedUid as string, c]));
    for (const c of connections) {
      if (c.status !== "accepted") continue;
      const uid = otherUid(c, user.uid);
      const p = c.profiles?.[uid];
      const mine = byUid.get(uid);
      out.push({
        ref: userRef(uid),
        name: mine?.customName?.trim() || profileName(p),
        isApp: true,
        email: p?.email ?? null,
        contactId: mine?.id ?? null,
        nicknames: mine?.nicknames ?? [],
        payAliases: mine?.payAliases ?? [],
      });
    }
    for (const c of contacts) {
      if (c.linkedUid || c.kind === "app") continue;
      out.push({
        ref: contactRef(c.id),
        name: contactDisplayName(c),
        isApp: false,
        email: c.email ?? null,
        contactId: c.id,
        nicknames: c.nicknames ?? [],
        payAliases: c.payAliases ?? [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [user, connections, contacts]);
  return { data: people, loading: l1 || l2 };
}

/**
 * Qué parte de cada gasto mío repartido es mía. `projected`: como si la gente
 * sin la app ya me hubiera pagado ("si te pagan lo que te deben").
 */
export function useSplitAdjustment(opts: { projected?: boolean } = {}): SharedAdjustment | undefined {
  const { user } = useAuth();
  const { data: splits } = useSplits();
  const { data: transfers } = usePersonTransfers();
  const projected = !!opts.projected;
  return useMemo(
    () => (user ? { byTxId: buildSplitAdjustment(user.uid, splits, transfers, { projected }) } : undefined),
    [user, splits, transfers, projected],
  );
}

/**
 * Cuánto me debe (o le debo a) cada persona. `nowMonth` (YYYY-MM): las
 * cuotas hasta ese mes son "de ahora", las posteriores "que vienen".
 */
export function usePeopleLedger(nowMonth?: string) {
  const { user } = useAuth();
  const { data: splits, loading: l1 } = useSplits();
  const { data: transfers, loading: l2 } = usePersonTransfers();
  const ledger = useMemo(
    () =>
      user
        ? computePeopleLedger({ me: user.uid, splits, transfers, nowMonth: nowMonth ?? paymentMonthOf(new Date()) })
        : new Map(),
    [user, splits, transfers, nowMonth],
  );
  return { ledger, splits, transfers, loading: l1 || l2 };
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

/**
 * Listas: todos los grupos y listas a los que tengo acceso (míos o
 * compartidos), por uid y por email (si me compartieron antes de tener cuenta).
 * Con esto se arma el árbol entero del lado del cliente.
 */
export function useLists() {
  const { user } = useAuth();
  const email = user?.email?.toLowerCase() ?? null;
  const byUid = useMemo(
    () => (user ? query(collection(db, listsCollectionPath()), where("memberUids", "array-contains", user.uid)) : null),
    [user],
  );
  const byEmail = useMemo(
    () => (email ? query(collection(db, listsCollectionPath()), where("memberEmails", "array-contains", email)) : null),
    [email],
  );
  const a = useCollection<ListNode>(byUid);
  const b = useCollection<ListNode>(byEmail);
  const data = useMemo(() => {
    const map = new Map<string, ListNode>();
    for (const x of [...a.data, ...b.data]) map.set(x.id, x);
    return [...map.values()];
  }, [a.data, b.data]);
  return { data, loading: a.loading || b.loading, error: a.error ?? b.error };
}
