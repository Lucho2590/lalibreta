"use client";

import { usePathname } from "next/navigation";
import { ProtectedRoute } from "./protected-route";
import { Header } from "./header";
import { BottomNav } from "./bottom-nav";
import { Sidebar } from "./sidebar";
import { PwaSetup } from "@/components/pwa/pwa-setup";
import { LocationPrompt } from "@/components/pwa/location-prompt";
import { NovedadesDialog } from "@/components/novedades/novedades-dialog";
import { NewTransactionSheetProvider } from "@/components/transactions/new-transaction-sheet";

const PUBLIC_ROUTES = ["/login"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (PUBLIC_ROUTES.includes(pathname)) return <>{children}</>;

  return (
    <ProtectedRoute>
      <PwaSetup />
      <NovedadesDialog />
      <LocationPrompt />
      <NewTransactionSheetProvider>
        <div className="flex min-h-screen">
          <Sidebar />
          {/* min-w-0: sin esto, en el celular la columna se estira al ancho de
              su contenido más largo y las tarjetas se salen de la pantalla. */}
          <div className="flex min-h-screen min-w-0 flex-1 flex-col overflow-x-clip">
            {/* Las dos barras son hijas directas de la columna: si van dentro
                de otro div, el sticky queda limitado a ese div y se van con
                el scroll. */}
            <Header variant="mobile" />
            <Header variant="desktop" />
            <main className="w-full min-w-0 flex-1 px-4 py-4 pb-[calc(6rem+env(safe-area-inset-bottom))] md:px-8 md:py-8 md:pb-10 md:max-w-6xl md:mx-auto">
              {children}
            </main>
            <BottomNav />
          </div>
        </div>
      </NewTransactionSheetProvider>
    </ProtectedRoute>
  );
}
