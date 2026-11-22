/**
 * Ficha de un contacto: cómo le digo (apodos) y a dónde le transfiero (alias,
 * CBU o CVU). Helpers puros: los usan la web, el server y el agente.
 */

/** Alias, CBU o CVU para transferirle, con una etiqueta opcional ("MP", "Galicia"). */
export interface PayAlias {
  value: string;
  label?: string | null;
}

export interface ContactInfoFields {
  /** Nombre que le pongo yo. En los que usan la app pisa el de su perfil. */
  customName?: string | null;
  /** Otras formas de nombrarlo ("Orne", "mi señora"): el agente lo encuentra por estas. */
  nicknames?: string[] | null;
  payAliases?: PayAlias[] | null;
}

/** Email como id del doc del contacto — normalizado para evitar caracteres ilegales. */
export const contactIdFromEmail = (email: string): string =>
  email.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");

export const MAX_NICKNAMES = 10;
export const MAX_PAY_ALIASES = 6;

/** Para comparar nombres: sin tildes, mayúsculas ni signos. */
export const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Nombre a mostrar: el que le puse yo, si no el de su perfil/contacto. */
export const contactDisplayName = (
  c: { customName?: string | null; displayName?: string | null; email?: string | null } | null | undefined,
  fallback = "Contacto",
) => c?.customName?.trim() || c?.displayName?.trim() || c?.email?.split("@")[0] || fallback;

/** Apodos limpios, sin repetidos ni el nombre principal. */
export const cleanNicknames = (list: Array<string | null | undefined>, mainName?: string | null): string[] => {
  const seen = new Set<string>(mainName ? [normName(mainName)] : []);
  const out: string[] = [];
  for (const raw of list) {
    const v = (raw ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const k = normName(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.slice(0, MAX_NICKNAMES);
};

/** Alias/CBU/CVU sin espacios; los CBU/CVU (22 dígitos) quedan solo con números. */
export const cleanPayAliasValue = (raw: string) => {
  const v = raw.trim().replace(/\s+/g, "");
  const digits = v.replace(/[-.]/g, "");
  return /^\d{22}$/.test(digits) ? digits : v.slice(0, 60);
};

export const payAliasKind = (value: string): "CBU/CVU" | "alias" => (/^\d{22}$/.test(value) ? "CBU/CVU" : "alias");

export const cleanPayAliases = (list: Array<PayAlias | null | undefined>): PayAlias[] => {
  const seen = new Set<string>();
  const out: PayAlias[] = [];
  for (const a of list) {
    if (!a) continue;
    const value = cleanPayAliasValue(a.value ?? "");
    const k = value.toLowerCase();
    if (!value || seen.has(k)) continue;
    seen.add(k);
    out.push({ value, label: a.label?.trim().slice(0, 30) || null });
  }
  return out.slice(0, MAX_PAY_ALIASES);
};

export const formatPayAlias = (a: PayAlias) => `${a.value}${a.label ? ` (${a.label})` : ""}`;

/**
 * ¿"q" nombra a esta persona? Exacto contra el nombre o un apodo, o una
 * palabra entera del nombre ("Orne" → "Orne Pérez"). Devuelve qué tan fuerte
 * es la coincidencia (2 exacta, 1 parcial, 0 nada).
 */
export const personMatchScore = (names: Array<string | null | undefined>, q: string): 0 | 1 | 2 => {
  const n = normName(q);
  if (!n) return 0;
  const all = names.map((x) => normName(x ?? "")).filter(Boolean);
  if (all.some((x) => x === n || x.replace(/ /g, "") === n.replace(/ /g, ""))) return 2;
  if (all.some((x) => x.split(" ").includes(n) || (n.length >= 3 && x.startsWith(n)))) return 1;
  return 0;
};
