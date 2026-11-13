import { NextResponse } from "next/server";
import {
  UnauthorizedError,
  getAuthedUser,
  unauthorizedResponse,
} from "@/lib/server/auth";
import { analyzeStatement } from "@/lib/server/statement-import";

export const runtime = "nodejs";
// Leer un resumen largo con IA puede tardar.
export const maxDuration = 300;

// Vercel limita el cuerpo de las funciones a ~4,5 MB.
const MAX_BYTES = 4 * 1024 * 1024;

/** Analiza un resumen de tarjeta (PDF o imagen). No guarda nada. */
export async function POST(req: Request) {
  let user;
  try {
    user = await getAuthedUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorizedResponse(err.message);
    throw err;
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo" }, { status: 400 });
  }
  const isPdf = file.type === "application/pdf";
  if (!isPdf && !file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Subí un PDF o una imagen del resumen" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "El archivo pesa más de 4 MB" }, { status: 413 });
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (isPdf && data.includes("/Encrypt")) {
    return NextResponse.json(
      { error: "El PDF tiene contraseña. Subí una versión sin contraseña o capturas del resumen." },
      { status: 400 },
    );
  }

  try {
    const analysis = await analyzeStatement(user.uid, {
      data,
      mimeType: file.type,
      filename: file.name,
    });
    return NextResponse.json(analysis);
  } catch (err) {
    console.error("[statements/analyze]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "No se pudo analizar el resumen" },
      { status: 500 },
    );
  }
}
