"use client";

import { cn } from "@/lib/utils";

/**
 * Muestra u oculta su contenido desplegándolo (alto + fundido), así lo que
 * está abajo se corre suave en vez de saltar. El contenido se queda montado
 * mientras se pliega: quien lo usa tiene que seguir pasándolo al ocultarlo.
 *
 * Dentro de un `space-y-*`, oculto no deja hueco (anula su propio margen).
 */
export function Reveal({
  show,
  children,
  className,
}: {
  show: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden={!show}
      inert={!show}
      className={cn(
        "grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out motion-reduce:transition-none",
        show ? "grid-rows-[1fr] opacity-100" : "mb-0 grid-rows-[0fr] opacity-0",
        className,
      )}
    >
      <div
        className={cn(
          "min-h-0 overflow-hidden transition-transform duration-300 ease-out motion-reduce:transition-none",
          show ? "translate-y-0" : "-translate-y-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}
