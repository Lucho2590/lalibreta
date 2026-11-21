import {
  Bell,
  CalendarDays,
  ClipboardCheck,
  CloudSun,
  CreditCard,
  FileText,
  Handshake,
  Home,
  List,
  MessageCircle,
  Repeat,
  Tag,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Nombre más corto para la grilla "Más" del celu. */
  mobileLabel?: string;
  /** Aclaración chiquita debajo del nombre (solo en el celu). */
  note?: string;
};

/** Todas las secciones de la app, en el orden por defecto. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/movimientos", label: "Movimientos", icon: List },
  { href: "/cuentas", label: "Cuentas", icon: CreditCard },
  { href: "/agenda", label: "Agenda", icon: CalendarDays },
  { href: "/clima", label: "Clima", icon: CloudSun },
  { href: "/resumenes", label: "Importar resumen", icon: FileText, note: "desde la compu" },
  { href: "/fijos", label: "Fijos", icon: Repeat },
  { href: "/ingresos", label: "Ingresos", icon: Wallet },
  { href: "/compartidas", label: "Cuentas con gente", icon: Handshake },
  { href: "/aprobaciones", label: "Aprobaciones", icon: ClipboardCheck },
  { href: "/contactos", label: "Contactos", icon: Users },
  { href: "/categorias", label: "Categorías", icon: Tag },
  { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { href: "/notificaciones", label: "Notificaciones", icon: Bell, mobileLabel: "Avisos" },
];

/** Las que en el celu van fijas en la barra de abajo (no se reordenan). */
export const BOTTOM_BAR_HREFS: readonly string[] = ["/", "/movimientos", "/cuentas"];

export const isNavActive = (href: string, pathname: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);

/**
 * Ordena las secciones según el orden guardado. Lo que no está guardado
 * (por ejemplo, una sección nueva) queda en su lugar por defecto, y lo
 * guardado que ya no existe se ignora.
 */
export const applyNavOrder = (order?: readonly string[] | null): NavItem[] => {
  if (!order?.length) return [...NAV_ITEMS];
  const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i]));
  const saved = order.filter((h, idx) => byHref.has(h) && order.indexOf(h) === idx);
  const result = saved.map((h) => byHref.get(h)!);
  NAV_ITEMS.forEach((item, defaultIdx) => {
    if (saved.includes(item.href)) return;
    result.splice(Math.min(defaultIdx, result.length), 0, item);
  });
  return result;
};

/**
 * Aplica el nuevo orden de un subconjunto (la grilla "Más") sobre el orden
 * completo: los del subconjunto se reacomodan en los lugares que ya ocupaban
 * y el resto (la barra de abajo) no se mueve.
 */
export const mergeSubsetOrder = (fullOrder: readonly string[], subsetNewOrder: readonly string[]): string[] => {
  const subset = new Set(subsetNewOrder);
  let next = 0;
  return fullOrder.map((h) => (subset.has(h) ? subsetNewOrder[next++] : h));
};
