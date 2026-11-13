import { renderAppIcon } from "@/lib/pwa/icon-art";

/**
 * Íconos del manifest: /pwa-icon/192.png, /pwa-icon/512.png (redondeados) y
 * /pwa-icon/maskable-512.png (cuadrado lleno para Android).
 */
const ICONS: Record<string, { size: number; rounded: boolean }> = {
  "192.png": { size: 192, rounded: true },
  "512.png": { size: 512, rounded: true },
  "maskable-192.png": { size: 192, rounded: false },
  "maskable-512.png": { size: 512, rounded: false },
};

export const dynamic = "force-static";

export const generateStaticParams = () => Object.keys(ICONS).map((file) => ({ file }));

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const icon = ICONS[file];
  if (!icon) return new Response("Not found", { status: 404 });
  return renderAppIcon(icon.size, { rounded: icon.rounded });
}
