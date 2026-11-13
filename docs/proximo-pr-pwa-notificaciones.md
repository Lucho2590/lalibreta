# Próximo PR: app instalable (PWA) + notificaciones

## Objetivo
1. Que La Libreta se pueda **instalar** en el escritorio y en el celular (PWA).
2. Que avise con **notificaciones de la app** (push del navegador o del sistema).

Hoy algunos avisos se mandan por WhatsApp, pero WhatsApp solo deja escribirle a alguien que le habló al bot en las últimas 24 h. Fuera de esa ventana hacen falta plantillas aprobadas por Meta. Las notificaciones pasan a vivir en la app.

## Avisos a cubrir
| Evento | Mensaje de ejemplo | Origen |
|---|---|---|
| Alguien cargó un gasto en una cuenta tuya compartida | "Orne cargó Supermercado por $15.000 con tu Visa Galicia" | `confirmSharedTransaction` (`src/lib/server/whatsapp/handle-message.ts`), `POST /api/account-shares/submit` |
| Alguien se unió a una cuenta que compartiste | "Orne ya comparte tu Visa Galicia" | `join_shared_account` (`src/lib/server/agent/tools.ts`) |
| Dejaron de compartir una cuenta | "Luciano dejó de compartir la Visa Galicia" | `stop_sharing` (`tools.ts`) |
| **Vencimiento de tarjeta** (nuevo) | "Mañana vence la Visa Galicia: $ 289.510 + US$ 26" | Job diario (ver abajo) |
| **Cierre de tarjeta** (nuevo, opcional) | "Hoy cierra la Visa: lo que compres desde mañana va al resumen de diciembre" | Job diario |
| **Fijos del mes** (nuevo) | "Hoy es 5: ¿cargo el sueldo de US$ 2.500?" | Job diario sobre `users/{uid}/recurring` |

Hoy todos esos avisos pasan por `notifyUser` (`src/lib/server/sharing.ts`), que intenta mandar un WhatsApp. La idea es reemplazarlo por un `notify(uid, evento)` que:
1. Guarde la notificación en `users/{uid}/notifications` (bandeja dentro de la app, con leída/no leída).
2. Mande un **web push** a los dispositivos suscriptos.
3. Opcionalmente, mande WhatsApp si el usuario le escribió al bot en las últimas 24 h.

## Piezas técnicas
- **PWA:**
  - `app/manifest.ts`: nombre "La Libreta", íconos, `display: standalone`, colores de la marca.
  - Service worker en `public/sw.js`, registrado desde el cliente.
  - Antes de empezar, leer `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md` (cubre manifest, service worker y web push) y `.../03-file-conventions/01-metadata/manifest.md` (lo pide AGENTS.md).
- **Web push:**
  - Claves VAPID en variables de entorno.
  - Suscripción por dispositivo en `users/{uid}/pushSubscriptions/{id}`.
  - Envío desde el server con la librería `web-push`.
  - En iOS solo funciona con la app instalada en la pantalla de inicio (iOS 16.4 o más).
- **Bandeja en la web:**
  - Campanita en el header y la barra lateral, con contador.
  - Página o hoja con la lista y "marcar como leída".
- **Job diario:**
  - Usar Vercel Cron (`vercel.json` → `/api/cron/daily`, protegido con `CRON_SECRET`).
  - Recorre los usuarios, mira los ciclos de cada tarjeta (`users/{uid}/accounts/{id}/cycles`, o el día de vencimiento por defecto) y los resúmenes guardados (`cardStatements`), y arma el aviso de vencimiento con el monto (`getCardStatement` / `getLatestStatement`).
- **Preferencias:** qué avisos recibir y con cuánta anticipación avisar los vencimientos (por ejemplo, 1 o 3 días antes).

## Pendientes relacionados (anotados en este PR)
- Que los **fijos** (sueldo, suscripciones) se apliquen solos el día que corresponde, o que avisen y se confirmen con un toque, en lugar de aplicarlos a mano desde el inicio.
- Ingreso de US$ 172,19 en el Galicia de Luciano: definir si queda como ingreso o se borra, porque en realidad era saldo.
