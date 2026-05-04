"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import { createContext, useContext, useEffect, useState } from "react";
import { auth } from "@/lib/firebase/client";
import { apiFetch } from "@/lib/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ user: null, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let lastInitedUid: string | null = null;
    const unsub = onAuthStateChanged(auth, async (next) => {
      setUser(next);
      setLoading(false);
      if (next && next.uid !== lastInitedUid) {
        lastInitedUid = next.uid;
        // Best-effort: registra/actualiza el doc users/{uid} para que otros
        // usuarios puedan resolver email -> uid. No bloqueamos si falla.
        try {
          await apiFetch("/api/users/init", { method: "POST" });
        } catch (err) {
          console.warn("[auth] users/init falló", err);
        }
      }
    });
    return unsub;
  }, []);

  return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
