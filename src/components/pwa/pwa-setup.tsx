"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { registerServiceWorker, resyncPush } from "@/lib/pwa/push-client";

/** Registra el service worker y re-sincroniza el push del usuario logueado. */
export function PwaSetup() {
  const { user } = useAuth();
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  useEffect(() => {
    if (user) void resyncPush();
  }, [user]);
  return null;
}
