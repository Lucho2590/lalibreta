"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading || user) return;
    // Volver a donde iba después de entrar (ej. el link de una invitación).
    const here = window.location.pathname + window.location.search;
    router.replace(here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`);
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Cargando…
      </div>
    );
  }
  return <>{children}</>;
}
