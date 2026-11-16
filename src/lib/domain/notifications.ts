/** Avisos de la app (bandeja + push). */

export type NotificationKind =
  | "shared-expense"
  | "share-joined"
  | "share-stopped"
  | "card-due"
  | "card-close"
  | "recurring-due"
  | "agenda-today"
  | "agenda-invite"
  | "agenda-response"
  | "agenda-changed"
  | "agenda-cancelled"
  // Cuentas con gente
  | "connection-request"
  | "connection-response"
  | "split-request"
  | "split-response"
  | "split-cancelled"
  | "p2p-request"
  | "p2p-response"
  | "debt-reminder"
  | "pending-reminder"
  | "test";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  url: string;
  read: boolean;
  createdAt: { toDate(): Date } | null;
}

/** Preferencias, guardadas en `users/{uid}.notificationPrefs`. */
export interface NotificationPrefs {
  /** Avisar antes de que venza una tarjeta. */
  cardDue: boolean;
  /** Con cuántos días de anticipación (0 = el mismo día). */
  cardDueDaysBefore: number;
  /** Avisar el día que cierra una tarjeta. */
  cardClose: boolean;
  /** Avisar los fijos del día (sueldo, suscripciones…). */
  recurring: boolean;
  /** Avisar movimientos en cuentas compartidas. */
  shared: boolean;
  /** A la mañana, lo que hay en la agenda del día. */
  agenda: boolean;
  /** Recordar cobrarle a la gente sin la app que me debe plata. */
  debts: boolean;
  /** Cada cuántos días recordarlo. */
  debtsEveryDays: number;
  /** Recordar lo que me mandaron para aceptar (gastos, transferencias, conexiones). */
  pendingReminders: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  cardDue: true,
  cardDueDaysBefore: 1,
  cardClose: false,
  recurring: true,
  shared: true,
  agenda: true,
  debts: true,
  debtsEveryDays: 7,
  pendingReminders: true,
};

export const withDefaultPrefs = (p: Partial<NotificationPrefs> | null | undefined): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...(p ?? {}),
});
