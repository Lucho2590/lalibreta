"use client";

import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMonth } from "@/hooks/use-month";
import { formatMonth } from "@/lib/format";

/**
 * Pantallas donde el mes elegido cambia lo que se ve. En las demás (Cuentas
 * muestra el saldo de hoy; Clima, Notificaciones…) el selector no se
 * muestra, para no confundir. Si una pantalla nueva usa useMonth(), sumarla acá.
 */
const MONTH_PAGES = ["/", "/movimientos", "/ingresos", "/fijos", "/compartidas", "/agenda"];
const MONTH_PAGE_PREFIXES = ["/cuentas/", "/compartidas/persona/"];

export const usesMonth = (pathname: string) =>
  MONTH_PAGES.includes(pathname) || MONTH_PAGE_PREFIXES.some((p) => pathname.startsWith(p));

export function MonthSelector() {
  const pathname = usePathname();
  const { year, month, shift } = useMonth();
  if (!usesMonth(pathname)) return null;
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" onClick={() => shift(-1)} aria-label="Mes anterior">
        <ChevronLeft className="size-5" />
      </Button>
      <div className="min-w-[140px] text-center text-sm font-medium">
        {formatMonth(year, month)}
      </div>
      <Button variant="ghost" size="icon" onClick={() => shift(1)} aria-label="Mes siguiente">
        <ChevronRight className="size-5" />
      </Button>
    </div>
  );
}
