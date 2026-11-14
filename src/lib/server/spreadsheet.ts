import "server-only";

import ExcelJS from "exceljs";

/**
 * Planillas que llegan por WhatsApp (xlsx o csv) → texto para el agente.
 * Leer la tabla como texto es más exacto y barato que mandarle una foto.
 */

export const MAX_SPREADSHEET_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 300;
const MAX_CHARS = 40_000;

export type SpreadsheetKind = "xlsx" | "csv" | "xls";

const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);
const CSV_MIMES = new Set(["text/csv", "text/comma-separated-values", "application/csv", "text/plain"]);

/** Qué tipo de planilla es, por extensión o tipo MIME. null si no es planilla. */
export const spreadsheetKind = (mime: string, filename?: string): SpreadsheetKind | null => {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "csv") return "csv";
  if (ext === "xls") return "xls";
  const m = mime.toLowerCase();
  if (XLSX_MIMES.has(m)) return "xlsx";
  if (m === "application/vnd.ms-excel") return "xls";
  if (CSV_MIMES.has(m) && ext !== "txt") return "csv";
  return null;
};

const cellText = (value: ExcelJS.CellValue): string => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text);
    if ("error" in value) return "";
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
};

const clip = (rows: string[]): { text: string; truncated: boolean } => {
  const out: string[] = [];
  let size = 0;
  for (const r of rows.slice(0, MAX_ROWS)) {
    if (size + r.length > MAX_CHARS) return { text: out.join("\n"), truncated: true };
    out.push(r);
    size += r.length + 1;
  }
  return { text: out.join("\n"), truncated: rows.length > MAX_ROWS };
};

const decodeText = (data: Buffer): string => {
  const utf8 = data.toString("utf8");
  // Los CSV que exporta Excel en español suelen venir en latin1.
  return utf8.includes("�") ? data.toString("latin1") : utf8;
};

/**
 * Devuelve la planilla como texto: una fila por línea, celdas separadas por
 * " | ". Si tiene varias hojas, todas (con su nombre).
 */
export const spreadsheetToText = async (
  data: Buffer,
  kind: "xlsx" | "csv",
): Promise<{ text: string; rows: number; truncated: boolean }> => {
  if (kind === "csv") {
    const lines = decodeText(data)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const { text, truncated } = clip(lines);
    return { text, rows: lines.length, truncated };
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const rows: string[] = [];
  let count = 0;
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== "visible") continue;
    const sheetRows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const cells = values.map((v) => cellText(v as ExcelJS.CellValue));
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.some(Boolean)) sheetRows.push(cells.join(" | "));
    });
    if (sheetRows.length === 0) continue;
    if (wb.worksheets.length > 1) rows.push(`### Hoja "${ws.name}"`);
    rows.push(...sheetRows);
    count += sheetRows.length;
  }
  const { text, truncated } = clip(rows);
  return { text, rows: count, truncated };
};
