/**
 * Achica una foto antes de subirla (en el navegador). Las fotos del iPhone
 * suelen pasar los 4 MB que acepta el servidor (Vercel corta a ~4,5 MB).
 * PDFs y archivos chicos se devuelven tal cual.
 */

const TARGET_BYTES = 3.5 * 1024 * 1024;
/** Lado largo máximo. */
const MAX_LONG_SIDE = 3000;
/** El lado corto nunca baja de esto (capturas largas del home banking). */
const MIN_SHORT_SIDE = 1200;
const QUALITIES = [0.85, 0.75, 0.65, 0.5];

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

export const compressImageForUpload = async (file: File): Promise<File> => {
  if (!file.type.startsWith("image/") || file.size <= TARGET_BYTES) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Formato que el navegador no sabe dibujar: lo mandamos como está.
    return file;
  }

  const long = Math.max(bitmap.width, bitmap.height);
  const short = Math.min(bitmap.width, bitmap.height);
  const scale = Math.min(1, Math.max(MAX_LONG_SIDE / long, Math.min(1, MIN_SHORT_SIDE / short)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let best: Blob | null = null;
  for (const q of QUALITIES) {
    best = await toBlob(canvas, q);
    if (best && best.size <= TARGET_BYTES) break;
  }
  if (!best || best.size >= file.size) return file;
  const name = file.name.replace(/\.[^.]+$/, "") || "resumen";
  return new File([best], `${name}.jpg`, { type: "image/jpeg" });
};
