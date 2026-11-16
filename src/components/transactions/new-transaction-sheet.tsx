"use client";

import { createContext, useCallback, useContext, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TransactionForm, type FormMode } from "./transaction-form";

interface SheetState {
  /** Abre el formulario, opcionalmente en un modo (ej. "exchange" para un cambio de dólares). */
  open: (mode?: FormMode) => void;
  close: () => void;
}

const Ctx = createContext<SheetState>({ open: () => {}, close: () => {} });

export function NewTransactionSheetProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [mode, setMode] = useState<FormMode>("expense");
  // Sin argumento (o con un evento de click) abre en "Gasto".
  const open = useCallback((m?: FormMode) => {
    setMode(typeof m === "string" ? m : "expense");
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      <Sheet open={isOpen} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0"
        >
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Nuevo movimiento</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            <TransactionForm key={mode} defaultKind={mode} onSubmitted={close} />
          </div>
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  );
}

export const useNewTransactionSheet = () => useContext(Ctx);
