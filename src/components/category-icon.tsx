import {
  Baby,
  Beer,
  BookOpen,
  Briefcase,
  Bus,
  Car,
  Coffee,
  CreditCard,
  Dumbbell,
  Film,
  Fuel,
  Gamepad2,
  Gift,
  HeartPulse,
  Home,
  type LucideIcon,
  MoreHorizontal,
  Music,
  PawPrint,
  PiggyBank,
  Plane,
  Receipt,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Stethoscope,
  Tag,
  Utensils,
  Wallet,
  Wrench,
  Zap,
} from "lucide-react";

export const CATEGORY_ICONS: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: "utensils", label: "Comida", icon: Utensils },
  { id: "coffee", label: "Café", icon: Coffee },
  { id: "beer", label: "Salidas", icon: Beer },
  { id: "shopping-cart", label: "Super", icon: ShoppingCart },
  { id: "shopping-bag", label: "Compras", icon: ShoppingBag },
  { id: "fuel", label: "Combustible", icon: Fuel },
  { id: "car", label: "Auto", icon: Car },
  { id: "bus", label: "Transporte", icon: Bus },
  { id: "plane", label: "Viajes", icon: Plane },
  { id: "home", label: "Hogar", icon: Home },
  { id: "zap", label: "Servicios", icon: Zap },
  { id: "smartphone", label: "Telefonía", icon: Smartphone },
  { id: "credit-card", label: "Suscripciones", icon: CreditCard },
  { id: "heart-pulse", label: "Salud", icon: HeartPulse },
  { id: "stethoscope", label: "Médico", icon: Stethoscope },
  { id: "dumbbell", label: "Gimnasio", icon: Dumbbell },
  { id: "shirt", label: "Ropa", icon: Shirt },
  { id: "gift", label: "Regalos", icon: Gift },
  { id: "film", label: "Cine", icon: Film },
  { id: "music", label: "Música", icon: Music },
  { id: "gamepad-2", label: "Juegos", icon: Gamepad2 },
  { id: "book-open", label: "Educación", icon: BookOpen },
  { id: "baby", label: "Niños", icon: Baby },
  { id: "paw-print", label: "Mascotas", icon: PawPrint },
  { id: "wrench", label: "Mantenim.", icon: Wrench },
  { id: "receipt", label: "Impuestos", icon: Receipt },
  { id: "briefcase", label: "Trabajo", icon: Briefcase },
  { id: "wallet", label: "Sueldo", icon: Wallet },
  { id: "piggy-bank", label: "Ahorro", icon: PiggyBank },
  { id: "sparkles", label: "Otros", icon: Sparkles },
  { id: "more-horizontal", label: "Más", icon: MoreHorizontal },
];

const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  CATEGORY_ICONS.map((c) => [c.id, c.icon]),
);

export function CategoryIcon({
  name,
  className,
}: {
  name?: string | null;
  className?: string;
}) {
  const Ico = (name && ICON_MAP[name]) || Tag;
  return <Ico className={className} />;
}
