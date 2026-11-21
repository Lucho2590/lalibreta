"use client";

import { useEffect, useRef, useState } from "react";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Un número que, cuando cambia, cuenta hasta el valor nuevo (sube o baja)
 * en vez de cambiar de golpe. Si cambia de nuevo a mitad de camino, sigue
 * desde donde estaba. Durante la animación muestra enteros; al final, el
 * valor exacto.
 */
export function AnimatedNumber({
  value,
  format,
  duration = 700,
  className,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const current = useRef(value);

  useEffect(() => {
    const from = current.current;
    if (from === value) return;
    const total = prefersReducedMotion() ? 0 : duration;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = total === 0 ? 1 : Math.min(1, (now - start) / total);
      // easeOutCubic: arranca rápido y frena al llegar.
      const eased = 1 - (1 - t) ** 3;
      const next = t === 1 ? value : from + (value - from) * eased;
      current.current = next;
      setDisplay(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return <span className={className}>{format(display === value ? value : Math.round(display))}</span>;
}
