import "server-only";

import { randomInt } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

/**
 * Cosas que recibe cada usuario al empezar:
 * - un set de categorías iniciales (una sola vez)
 * - un "agente de cuentas" con nombre de personaje, elegido al azar y fijo
 */

// === Agentes ===

export interface AgentPersona {
  name: string;
  /** Guiño de personalidad para el prompt (sutil, sin trabar las respuestas). */
  flavor: string;
}

export const AGENT_PERSONAS: AgentPersona[] = [
  { name: "Don Ramón", flavor: "Don Ramón del Chavo: quejoso y pícaro, siempre debe la renta; alguna vez suelta \"¿qué pasó, qué pasó, vamos a ver?\" o se hace el distraído con las deudas." },
  { name: "Pepe Argento", flavor: "Pepe Argento: vendedor de zapatos de Buenos Aires, renegón y canchero, se queja de los gastos de la familia y de los impuestos." },
  { name: "el Señor Barriga", flavor: "el Señor Barriga del Chavo: el dueño de la vecindad que viene a cobrar la renta; amable pero siempre pendiente de que las cuentas cierren." },
  { name: "el Pato Donald", flavor: "el Pato Donald: entusiasta y cascarrabias, se indigna con los precios." },
  { name: "Superman", flavor: "Superman: heroico y optimista, ve cada gasto ahorrado como una pequeña victoria para la humanidad." },
  { name: "el Hombre Araña", flavor: "el Hombre Araña: buena onda y con humor, le recuerda al usuario que un gran poder (la tarjeta) conlleva una gran responsabilidad." },
  { name: "el Chapulín Colorado", flavor: "el Chapulín Colorado: \"¡No contaban con mi astucia!\", torpe pero bienintencionado; \"síganme los buenos\"." },
  { name: "Homero Simpson", flavor: "Homero Simpson: distraído y glotón, se tienta con las donas y los gastos en comida; algún \"¡D'oh!\" cuando algo sale caro." },
  { name: "Batman", flavor: "Batman: serio y detectivesco, investiga cada gasto como si fuera un caso de Ciudad Gótica." },
  { name: "Mafalda", flavor: "Mafalda: chica reflexiva y crítica, opina sobre la economía y el mundo; odia la sopa." },
  { name: "Patoruzú", flavor: "Patoruzú: cacique generoso y millonario de la Patagonia, bonachón; a veces bromea con prestarle plata a Isidoro." },
  { name: "Isidoro Cañones", flavor: "Isidoro Cañones: porteño fiestero y derrochador que siempre busca a alguien que le pague las cuentas." },
  { name: "Condorito", flavor: "Condorito: simpático y desafortunado; cuando algo sale mal (un gasto inesperado) remata con un \"¡Plop!\"." },
  { name: "Moni Argento", flavor: "Moni Argento: ama de casa intensa y dramática, administra los gastos de la casa con mucho carácter." },
  { name: "el Chavo del 8", flavor: "el Chavo del 8: inocente y tierno, sueña con una torta de jamón; \"fue sin querer queriendo\"." },
  { name: "Gokú", flavor: "Gokú: inocente y entusiasta, todo lo compara con entrenar y comer; se emociona con los desafíos." },
];

export const pickAgentName = (): string =>
  AGENT_PERSONAS[randomInt(0, AGENT_PERSONAS.length)].name;

export const personaFor = (name: string | null | undefined): AgentPersona | null =>
  AGENT_PERSONAS.find((p) => p.name === name) ?? null;

/** Devuelve el nombre del agente del usuario, asignándole uno si no tiene. */
export const ensureAgentName = async (uid: string): Promise<string> => {
  const ref = adminDb().collection("users").doc(uid);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data()?.agentName as string | undefined;
    if (current) return current;
    const name = pickAgentName();
    tx.set(ref, { agentName: name, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return name;
  });
};

// === Categorías iniciales ===

const DEFAULT_CATEGORIES: Array<{ slug: string; name: string; icon: string; kind: "expense" | "income" }> = [
  { slug: "supermercado", name: "Supermercado", icon: "shopping-cart", kind: "expense" },
  { slug: "comida", name: "Comida y delivery", icon: "utensils", kind: "expense" },
  { slug: "salidas", name: "Salidas", icon: "beer", kind: "expense" },
  { slug: "combustible", name: "Combustible", icon: "fuel", kind: "expense" },
  { slug: "transporte", name: "Transporte", icon: "bus", kind: "expense" },
  { slug: "auto", name: "Auto", icon: "car", kind: "expense" },
  { slug: "hogar", name: "Hogar", icon: "home", kind: "expense" },
  { slug: "servicios", name: "Servicios", icon: "zap", kind: "expense" },
  { slug: "salud", name: "Salud", icon: "heart-pulse", kind: "expense" },
  { slug: "ropa", name: "Ropa", icon: "shirt", kind: "expense" },
  { slug: "suscripciones", name: "Suscripciones", icon: "film", kind: "expense" },
  { slug: "impuestos", name: "Impuestos y comisiones", icon: "receipt", kind: "expense" },
  { slug: "educacion", name: "Educación", icon: "book-open", kind: "expense" },
  { slug: "mascotas", name: "Mascotas", icon: "paw-print", kind: "expense" },
  { slug: "regalos", name: "Regalos", icon: "gift", kind: "expense" },
  { slug: "viajes", name: "Viajes", icon: "plane", kind: "expense" },
  { slug: "otros", name: "Otros", icon: "more-horizontal", kind: "expense" },
  { slug: "sueldo", name: "Sueldo", icon: "briefcase", kind: "income" },
  { slug: "freelance", name: "Freelance", icon: "wallet", kind: "income" },
  { slug: "rendimientos", name: "Rendimientos", icon: "piggy-bank", kind: "income" },
  { slug: "otros-ingresos", name: "Otros ingresos", icon: "sparkles", kind: "income" },
];

/**
 * Crea las categorías iniciales una sola vez por usuario (marca
 * users/{uid}.categoriesSeeded). Si el usuario ya tenía categorías propias,
 * no agrega nada. Ids fijos: si dos pestañas lo llaman a la vez, no duplica.
 */
export const seedDefaultCategories = async (uid: string): Promise<boolean> => {
  const db = adminDb();
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (userSnap.data()?.categoriesSeeded) return false;

  const col = db.collection(`users/${uid}/categories`);
  const existing = await col.limit(1).get();
  const batch = db.batch();
  if (existing.empty) {
    const now = Timestamp.now();
    for (const c of DEFAULT_CATEGORIES) {
      batch.set(col.doc(`default-${c.slug}`), {
        name: c.name,
        icon: c.icon,
        color: "",
        kind: c.kind,
        createdAt: now,
      });
    }
  }
  batch.set(userRef, { categoriesSeeded: true }, { merge: true });
  await batch.commit();
  return existing.empty;
};
