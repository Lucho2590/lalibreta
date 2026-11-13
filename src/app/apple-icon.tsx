import { renderAppIcon } from "@/lib/pwa/icon-art";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS redondea las esquinas solo: va el cuadrado lleno.
export default function AppleIcon() {
  return renderAppIcon(180);
}
