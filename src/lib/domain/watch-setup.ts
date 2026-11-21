/**
 * Cómo ver los avisos de La Libreta en un reloj inteligente. El reloj no
 * recibe nada de la app directamente: muestra lo que llega al celular. Lo usan
 * la pantalla de Notificaciones y el agente de WhatsApp (herramienta
 * watch_notifications), así los dos dicen lo mismo.
 */

export type WatchSetupId = "apple-watch" | "wear-os" | "band-android" | "band-iphone";

export interface WatchSetupGuide {
  id: WatchSetupId;
  /** Nombre corto para elegirlo. */
  label: string;
  /** Ejemplos de relojes, para reconocerse. */
  examples: string;
  /** Aclaración antes de los pasos, si hace falta. */
  note?: string;
  steps: string[];
  /**
   * El reloj no puede mostrar los avisos de la web app; hay que usar la copia
   * por WhatsApp.
   */
  needsWhatsappCopy: boolean;
}

const ENABLE_PUSH = "En el celular, abrí La Libreta (instalada) y en Notificaciones › Configuración tocá «Activar avisos».";

const WHATSAPP_COPY_STEPS = [
  "Vinculá tu WhatsApp con La Libreta, si todavía no lo hiciste (menú › WhatsApp).",
  "En Notificaciones › Configuración, prendé «Copia por WhatsApp» (o pedíselo a tu agente por WhatsApp).",
];

const PROBAR = "Tocá «Probar» en Notificaciones › Configuración, con el celular bloqueado: el reloj tiene que vibrar.";

export const WATCH_SETUP_GUIDES: WatchSetupGuide[] = [
  {
    id: "apple-watch",
    label: "Apple Watch",
    examples: "Apple Watch con iPhone",
    needsWhatsappCopy: false,
    steps: [
      "Instalá La Libreta en el iPhone: en Safari, Compartir › Agregar a inicio. Los avisos solo andan con la app instalada.",
      ENABLE_PUSH,
      "En el iPhone: Ajustes › Notificaciones › La Libreta › activá Pantalla bloqueada y Centro de notificaciones, y poné «Mostrar previsualizaciones» en Siempre.",
      "En la app Watch del iPhone: Notificaciones › en «Duplicar alertas del iPhone de», activá La Libreta.",
      "El Apple Watch muestra el aviso cuando el iPhone está bloqueado y el reloj lo tenés puesto.",
      PROBAR,
      "Si La Libreta no aparece en la app Watch, usá la «Copia por WhatsApp».",
    ],
  },
  {
    id: "wear-os",
    label: "Wear OS / Galaxy Watch",
    examples: "Galaxy Watch, Pixel Watch y otros con Wear OS, con Android",
    needsWhatsappCopy: false,
    steps: [
      "Instalá La Libreta en el celular: en Chrome, menú ⋮ › Instalar app.",
      ENABLE_PUSH,
      "Android: Ajustes › Notificaciones › La Libreta (o Chrome) › que estén permitidas.",
      "En Galaxy Wearable (o la app Pixel Watch / Wear OS): Notificaciones › activá La Libreta. Si no está, activá Chrome.",
      PROBAR,
    ],
  },
  {
    id: "band-android",
    label: "Otra marca con Android",
    examples: "Amazfit, Xiaomi, Huawei, Garmin y similares, con Android",
    needsWhatsappCopy: false,
    steps: [
      "Instalá La Libreta en el celular: en Chrome, menú ⋮ › Instalar app.",
      ENABLE_PUSH,
      "En la app del reloj (Zepp, Mi Fitness, Huawei Health, Garmin Connect): Notificaciones o Alertas de apps › activá La Libreta. Si no está, activá Chrome.",
      "Si te lo pide, dale a esa app el permiso de «Acceso a notificaciones» en los ajustes de Android, y sacala del ahorro de batería.",
      PROBAR,
      "Si no hay forma de que aparezca, usá la «Copia por WhatsApp».",
    ],
  },
  {
    id: "band-iphone",
    label: "Otra marca con iPhone",
    examples: "Amazfit, Xiaomi, Huawei, Garmin y similares, con iPhone",
    needsWhatsappCopy: true,
    note: "Con iPhone, estos relojes no muestran los avisos de las web apps: La Libreta no aparece en la lista de la app del reloj. La solución es que te lleguen también por WhatsApp.",
    steps: [
      ...WHATSAPP_COPY_STEPS,
      "En la app del reloj (Zepp, Mi Fitness, Huawei Health, Garmin Connect): Notificaciones o Alertas de apps › activá WhatsApp.",
      "En el iPhone: Ajustes › Notificaciones › WhatsApp › «Mostrar previsualizaciones» en Siempre. Si no, al reloj llega sin texto.",
      "Si tu reloj tiene «filtro inteligente» o «solo con el teléfono bloqueado», revisalos: pueden frenar los avisos.",
      PROBAR,
    ],
  },
];

export const watchGuide = (id: WatchSetupId) => WATCH_SETUP_GUIDES.find((g) => g.id === id)!;
