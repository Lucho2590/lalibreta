import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

/** Mismos ids que CATEGORY_ICONS (components/category-icon.tsx). */
export const CATEGORY_ICON_IDS = [
  "utensils", "coffee", "beer", "shopping-cart", "shopping-bag", "fuel", "car", "bus",
  "plane", "home", "zap", "smartphone", "credit-card", "heart-pulse", "stethoscope",
  "dumbbell", "shirt", "gift", "film", "music", "book-open", "baby", "paw-print",
  "wrench", "receipt", "briefcase", "wallet", "piggy-bank", "sparkles", "more-horizontal",
] as const;

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

export interface NewCategoryInput {
  name: string;
  kind: "expense" | "income";
  icon?: string | null;
}

/**
 * Crea una categoría (o devuelve la existente con el mismo nombre y tipo,
 * para no duplicar si se confirma dos veces).
 */
export const createCategoryAdmin = async (
  uid: string,
  input: NewCategoryInput,
): Promise<{ id: string; name: string; created: boolean }> => {
  const col = adminDb().collection(`users/${uid}/categories`);
  const existing = (await col.get()).docs.find(
    (d) => d.data().kind === input.kind && normalize(String(d.data().name ?? "")) === normalize(input.name),
  );
  if (existing) return { id: existing.id, name: String(existing.data().name), created: false };

  const icon = (CATEGORY_ICON_IDS as readonly string[]).includes(input.icon ?? "")
    ? input.icon!
    : "more-horizontal";
  const ref = await col.add({
    name: input.name.trim(),
    icon,
    color: "",
    kind: input.kind,
    createdAt: Timestamp.now(),
  });
  return { id: ref.id, name: input.name.trim(), created: true };
};
