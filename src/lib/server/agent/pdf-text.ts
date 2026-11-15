import "server-only";

import { extractTextItems } from "unpdf";

/**
 * Saca el texto de un PDF digital (resúmenes de tarjeta, facturas) para
 * mandárselo al modelo como texto: si va como archivo, OpenAI cobra el texto
 * Y una imagen de cada página.
 *
 * Rearma cada renglón según la posición de cada pedazo de texto, para que las
 * columnas (pesos / dólares) queden alineadas como en el papel.
 *
 * Devuelve null si el PDF no tiene texto (escaneado) o si algo falla: en ese
 * caso se manda el archivo como siempre. `PDF_TEXT_EXTRACTION=off` lo apaga.
 */

/** Menos que esto por página = PDF escaneado o casi vacío. */
const MIN_CHARS_PER_PAGE = 100;
/** Dos pedazos con menos de esta diferencia de altura van en el mismo renglón. */
const LINE_TOLERANCE_PT = 2;
const MAX_COLUMNS = 220;

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const renderPage = (items: Item[]): string => {
  const parts = items.filter((i) => i.str.trim());
  if (parts.length === 0) return "";

  // Ancho de un carácter en esta página: convierte posiciones en columnas.
  const charWidths = parts
    .filter((i) => i.width > 0 && i.str.length > 0)
    .map((i) => i.width / i.str.length);
  const unit = median(charWidths) || median(parts.map((i) => i.fontSize)) * 0.5 || 5;
  const minX = Math.min(...parts.map((i) => i.x));

  // Agrupar en renglones (y crece hacia arriba en coordenadas PDF).
  const byY = [...parts].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Item[][] = [];
  for (const item of byY) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].y - item.y) <= LINE_TOLERANCE_PT) line.push(item);
    else lines.push([item]);
  }

  return lines
    .map((line) => {
      let out = "";
      for (const item of line.sort((a, b) => a.x - b.x)) {
        const col = Math.min(MAX_COLUMNS, Math.round((item.x - minX) / unit));
        const pad = out.length === 0 ? col : Math.max(1, col - out.length);
        out += " ".repeat(pad) + item.str.trim();
      }
      return out.trimEnd();
    })
    .filter(Boolean)
    .join("\n");
};

export const extractPdfText = async (data: Buffer): Promise<string | null> => {
  if (process.env.PDF_TEXT_EXTRACTION === "off") return null;
  try {
    const { totalPages, items } = await extractTextItems(new Uint8Array(data));
    const pages = items.map(renderPage);
    const chars = pages.reduce((n, p) => n + p.replace(/\s/g, "").length, 0);
    if (totalPages === 0 || chars < MIN_CHARS_PER_PAGE * totalPages) return null;
    return pages.map((p, i) => `--- página ${i + 1} ---\n${p}`).join("\n\n");
  } catch (err) {
    console.warn("[pdf-text] no se pudo extraer el texto; mando el PDF", err);
    return null;
  }
};
