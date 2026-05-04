"use client";

import { usePathname } from "next/navigation";
import { ProtectedRoute } from "./protected-route";
import { Header } from "./header";
import { BottomNav } from "./bottom-nav";
import { Sidebar } from "./sidebar";
import { NewTransactionSheetProvider } from "@/components/transactions/new-transaction-sheet";

const PUBLIC_ROUTES = ["/login"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (PUBLIC_ROUTES.includes(pathname)) return <>{children}</>;

  return (
    <ProtectedRoute>
      <NewTransactionSheetProvider>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex min-h-screen flex-1 flex-col">
            <Header variant="mobile" />
            <div className="hidden md:block">
              <Header variant="desktop" />
            </div>
            <main className="flex-1 px-4 py-4 pb-24 md:px-8 md:py-8 md:pb-10 md:max-w-6xl md:mx-auto md:w-full">
              {children}
            </main>
            <BottomNav />
          </div>
        </div>
      </NewTransactionSheetProvider>
    </ProtectedRoute>
  );
}
