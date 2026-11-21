import type { CSSProperties } from "react";

/**
 * Entrada de una fila de lista: fundido + deslizamiento desde arriba. Se
 * dispara cuando el elemento se monta (fila nueva, otro mes, otro filtro).
 * Con `enterDelay(i)` las filas entran en cascada, de arriba hacia abajo.
 */
export const ENTER =
  "animate-in fade-in-0 slide-in-from-top-2 fill-mode-backwards duration-300 motion-reduce:animate-none";

export const enterDelay = (index: number): CSSProperties => ({ animationDelay: `${Math.min(index, 12) * 40}ms` });
