"use client";

import { apiFetch } from "@/lib/api";

/** Helpers del navegador para la PWA: service worker, push e instalación. */

const urlBase64ToUint8Array = (base64String: string) => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
};

export const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

export const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** ¿Se abrió como app instalada (pantalla de inicio / ventana propia)? */
export const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

export const registerServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch (err) {
    console.warn("[pwa] no se pudo registrar el service worker", err);
    return null;
  }
};

const readyRegistration = async () => {
  await registerServiceWorker();
  return navigator.serviceWorker.ready;
};

export const getCurrentSubscription = async (): Promise<PushSubscription | null> => {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
};

const saveOnServer = async (sub: PushSubscription) => {
  const res = await apiFetch("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!res.ok) throw new Error("No se pudo guardar la suscripción");
};

/** Pide permiso y suscribe este dispositivo. Tiene que llamarse desde un clic. */
export const enablePush = async (): Promise<"granted" | "denied" | "unsupported" | "missing-key"> => {
  if (!pushSupported()) return "unsupported";
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return "missing-key";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const reg = await readyRegistration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    }));
  await saveOnServer(sub);
  return "granted";
};

export const disablePush = async () => {
  const sub = await getCurrentSubscription();
  if (!sub) return;
  await apiFetch("/api/push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe();
};

/**
 * Al entrar: si este dispositivo ya tenía push, se vuelve a guardar a nombre
 * del usuario logueado (por si cambió de cuenta o el server la borró).
 */
export const resyncPush = async () => {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const sub = await getCurrentSubscription();
  if (sub) await saveOnServer(sub).catch(() => {});
};

// --- Instalación (Chrome/Edge/Android). En iOS y Safari no existe: se explica a mano.

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredInstall: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    listeners.forEach((l) => l());
  });
}

export const canPromptInstall = () => deferredInstall !== null;

export const onInstallAvailabilityChange = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const promptInstall = async (): Promise<boolean> => {
  if (!deferredInstall) return false;
  await deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  listeners.forEach((l) => l());
  return outcome === "accepted";
};
