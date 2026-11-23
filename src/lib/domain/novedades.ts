/**
 * Novedades de La Libreta. Al abrir la app, cada usuario ve las que salieron
 * después de la última que vio (`users/{uid}.novedadesSeen`, una fecha
 * YYYY-MM-DD) o, si nunca vio ninguna, después de que se registró: a quien
 * recién llega no le contamos como "nuevo" lo que ya estaba.
 *
 * Para sumar una novedad: agregala ARRIBA de todo con la fecha de hoy.
 */

export type NovedadIcon =
  | "vaquitas"
  | "listas"
  | "contactos"
  | "inicio"
  | "monedas"
  | "agenda"
  | "clima"
  | "reloj"
  | "editar"
  | "gente"
  | "resumen";

export interface Novedad {
  id: string;
  /** Día en que salió (YYYY-MM-DD). */
  date: string;
  icon: NovedadIcon;
  title: string;
  body: string;
  /** Algo para escribirle al agente por WhatsApp. */
  whatsapp?: string;
  /** Dónde verlo en la app. */
  href?: string;
  cta?: string;
}

/** De la más nueva a la más vieja. */
export const NOVEDADES: Novedad[] = [
  {
    id: "vaquitas-pasar-gasto",
    // Un día después de la de resúmenes: quien ya la vio también ve esta.
    date: "2026-11-24",
    icon: "vaquitas",
    title: "Pasá un gasto a una vaquita",
    body: "¿Lo cargaste como gasto común y era de la vaquita? En Movimientos tocá «Pasar a una vaquita»: queda en la misma tarjeta o cuenta, sin duplicarse, y en tus gastos cuenta solo tu parte. Además, cargar un gasto en la vaquita es más corto: primero quién pagó, después el monto, y listo. Y si alguien de la vaquita se sumó después a La Libreta, vinculalo (la app te lo sugiere): ve la vaquita y su parte va a sus gastos. Tu agente ya conoce a todos los de tus vaquitas, aunque no estén en tus contactos, y por WhatsApp también suma gente, corrige o borra gastos de la vaquita.",
    whatsapp: "en la vaquita, Ale pagó 32 mil del súper",
    href: "/movimientos",
    cta: "Ver movimientos",
  },
  {
    id: "resumen-celu",
    // Un día después de las de hoy: quien ya las vio también ve esta.
    date: "2026-11-23",
    icon: "resumen",
    title: "Importar resúmenes desde el celu",
    body: "Subí el PDF o una foto del resumen de la tarjeta desde el celular: la app lee los consumos, les ponés categoría y no duplica lo que ya tenías. Si se lo mandás a tu agente por WhatsApp, reconoce la tarjeta por los últimos 4 números y aprende las categorías igual que la app.",
    href: "/resumenes",
    cta: "Importar un resumen",
  },
  {
    id: "agregar-contacto",
    date: "2026-11-22",
    icon: "gente",
    title: "Sumá a tu gente a La Libreta",
    body: "En Contactos escribí el WhatsApp o el email de alguien, o buscá en tu agenda, y te decimos al toque quién ya usa La Libreta: a esos les mandás la solicitud con un toque; al resto lo invitás por WhatsApp o le llega un mail tuyo. También podés compartirle contactos a tu agente por WhatsApp (📎 → Contacto).",
    whatsapp: "agregá a 11 5555-1234",
    href: "/contactos",
    cta: "Agregar un contacto",
  },
  {
    id: "vaquitas",
    date: "2026-11-22",
    icon: "vaquitas",
    title: "Vaquitas",
    body: "Gastos en grupo para un viaje, un asado o una salida: quién puso qué y quién le paga a quién, con la menor cantidad de pagos. Podés sumar familias (cuentan como una parte) y gente sin la app.",
    whatsapp: "anotá en la vaquita del viaje: nafta 40 mil",
    href: "/vaquitas",
    cta: "Armar una vaquita",
  },
  {
    id: "listas",
    date: "2026-11-22",
    icon: "listas",
    title: "Listas",
    body: "Súper, regalos, invitados: listas con precio estimado y tope de gasto, agrupadas como quieras y compartidas con quien quieras. Cuando comprás algo, cargás el gasto desde la lista y se suma al tope.",
    whatsapp: "agregá yerba y café a la lista del súper",
    href: "/listas",
    cta: "Ver mis listas",
  },
  {
    id: "contactos",
    date: "2026-11-22",
    icon: "contactos",
    title: "Contactos con apodos y alias",
    body: "Cada contacto tiene su ficha con apodos («mi señora», «el Colo») y su alias o CBU para transferirle. El agente los reconoce por el apodo y te pasa el alias listo para copiar.",
    whatsapp: "pasame el alias de Juan",
    href: "/contactos",
    cta: "Ver contactos",
  },
  {
    id: "inicio",
    date: "2026-11-21",
    icon: "inicio",
    title: "Inicio y menú a tu gusto",
    body: "El inicio muestra primero tu balance, y los fijos, la agenda o el clima quedan como íconos arriba. Además podés ordenar el menú: en el celular, en «Más», mantené apretado un ícono y movelo; en la compu, arrastrá la fila. Y la app abre al instante con lo último que viste.",
  },
  {
    id: "monedas",
    date: "2026-11-21",
    icon: "monedas",
    title: "Euros, reales y más monedas",
    body: "Además de pesos y dólares, ahora podés tener cuentas en euros, libras, reales, pesos uruguayos y chilenos. Los totales en pesos usan la cotización oficial del BCRA.",
    whatsapp: "¿a cuánto está el euro?",
    href: "/cuentas",
    cta: "Ir a Cuentas",
  },
  {
    id: "agenda",
    date: "2026-11-21",
    icon: "agenda",
    title: "Agenda con calendario",
    body: "Vista de calendario y filtro por mes. Podés verla en Google Calendar o en el calendario del celular, e invitar a otros a tus actividades: si cambiás algo, les llega el aviso.",
    whatsapp: "el sábado a las 21 cena con Orne",
    href: "/agenda",
    cta: "Ver la agenda",
  },
  {
    id: "clima",
    date: "2026-11-21",
    icon: "clima",
    title: "Clima y alertas del SMN",
    body: "El pronóstico de donde estás y las alertas oficiales del SMN (tormentas, viento, calor) en tu zona, que te llegan como aviso.",
    whatsapp: "¿llueve mañana?",
    href: "/clima",
    cta: "Ver el clima",
  },
  {
    id: "reloj",
    date: "2026-11-21",
    icon: "reloj",
    title: "Avisos en el reloj",
    body: "Los avisos ahora se pueden borrar, y en Notificaciones › Configuración tenés los pasos para verlos en tu reloj inteligente. Si tu reloj no los muestra, prendé la copia por WhatsApp.",
    whatsapp: "¿cómo hago para que me lleguen los avisos al reloj?",
    href: "/notificaciones",
    cta: "Configurar avisos",
  },
  {
    id: "editar",
    date: "2026-11-17",
    icon: "editar",
    title: "Editar lo que ya cargaste",
    body: "Con el lápiz ✏️ cambiás monto, cuenta, categoría, fecha o cuotas de un gasto o ingreso, y también tus fijos. Si estaba dividido con alguien, se recalcula y le avisa.",
    href: "/movimientos",
    cta: "Ir a Movimientos",
  },
  {
    id: "gente",
    date: "2026-11-16",
    icon: "gente",
    title: "Cuentas con gente",
    body: "Dividí gastos con otras personas (en partes o en cuotas), anotá lo que le pasaste o te prestaron, y mirá quién te debe y a quién le debés. Con «dividir siempre», los gastos de un comercio se dividen solos.",
    whatsapp: "la mitad es de Orne",
    href: "/compartidas",
    cta: "Ver cuentas con gente",
  },
];

export const LATEST_NOVEDAD = NOVEDADES[0]?.date ?? "";

/** Fecha YYYY-MM-DD en Argentina. */
export const arDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

/**
 * Las que le tocan ver: posteriores a la última que vio o, si nunca vio
 * ninguna, a la fecha en que se registró.
 */
export const pendingNovedades = (seen: string | null | undefined, signedUpAt: string | null): Novedad[] => {
  const since = seen ?? signedUpAt;
  return since ? NOVEDADES.filter((n) => n.date > since) : NOVEDADES;
};
