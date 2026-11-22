"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatementReview } from "@/components/statements/statement-review";
import { apiFetch } from "@/lib/api";
import { compressImageForUpload } from "@/lib/image-compress";
import { cn } from "@/lib/utils";
import type { ImportResult, StatementAnalysis } from "@/lib/domain/statement-import";

const MAX_BYTES = 4 * 1024 * 1024;

type Step =
  | { kind: "upload" }
  | { kind: "analyzing"; filename: string }
  | { kind: "review"; analysis: StatementAnalysis }
  | { kind: "done"; result: ImportResult };

export default function ResumenesPage() {
  const params = useSearchParams();
  const preselected = params.get("account");
  const [step, setStep] = useState<Step>({ kind: "upload" });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Importar resumen</h1>
        <p className="text-sm text-muted-foreground">
          Subí el resumen de una tarjeta: tu agente lo lee, te muestra los consumos y vos les ponés
          categoría. Lo que elijas lo recuerda para los próximos.
        </p>
      </div>

      <div>
        {step.kind === "upload" && (
          <UploadZone
            onFile={async (file) => {
              setStep({ kind: "analyzing", filename: file.name });
              try {
                const form = new FormData();
                form.append("file", file);
                const res = await apiFetch("/api/statements/analyze", { method: "POST", body: form });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? "No se pudo analizar");
                setStep({ kind: "review", analysis: data as StatementAnalysis });
              } catch (err) {
                console.error(err);
                toast.error(err instanceof Error ? err.message : "No se pudo analizar el resumen");
                setStep({ kind: "upload" });
              }
            }}
          />
        )}

        {step.kind === "analyzing" && (
          <Card className="rounded-3xl">
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <Loader2 className="size-8 animate-spin text-brand" />
              <p className="font-medium">Leyendo el resumen…</p>
              <p className="text-sm text-muted-foreground">
                {step.filename} · puede tardar hasta un minuto si es largo.
              </p>
            </CardContent>
          </Card>
        )}

        {step.kind === "review" && (
          <StatementReview
            analysis={step.analysis}
            preselectedAccountId={preselected}
            onCancel={() => setStep({ kind: "upload" })}
            onImported={(result) => setStep({ kind: "done", result })}
          />
        )}

        {step.kind === "done" && (
          <Card className="rounded-3xl">
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <CheckCircle2 className="size-10 text-emerald-600" />
              <p className="text-lg font-semibold">
                Cargué {step.result.created} {step.result.created === 1 ? "consumo" : "consumos"} en{" "}
                {step.result.accountName}
              </p>
              <p className="text-sm text-muted-foreground">
                {step.result.createdAccount ? "Creé la tarjeta. " : ""}
                {step.result.skipped > 0 ? `${step.result.skipped} ya estaban cargados. ` : ""}
                Aprendí la categoría de {step.result.rulesSaved}{" "}
                {step.result.rulesSaved === 1 ? "comercio" : "comercios"} para la próxima.
                {step.result.projected > 0
                  ? ` Proyecté ${step.result.projected} ${step.result.projected === 1 ? "suscripción" : "suscripciones"} al próximo resumen (como estimado).`
                  : ""}
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Link
                  href={`/cuentas/${step.result.accountId}`}
                  className={cn(buttonVariants(), "rounded-xl bg-brand-grad text-white hover:opacity-95")}
                >
                  Ver la tarjeta
                </Link>
                <button
                  type="button"
                  onClick={() => setStep({ kind: "upload" })}
                  className={cn(buttonVariants({ variant: "outline" }), "rounded-xl")}
                >
                  Importar otro
                </button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function UploadZone({ onFile }: { onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.type !== "application/pdf" && !picked.type.startsWith("image/")) {
      toast.error("Subí un PDF o una imagen del resumen");
      return;
    }
    // Las fotos del celu suelen pasar el límite: las achicamos antes de subirlas.
    const file = await compressImageForUpload(picked);
    if (file.size > MAX_BYTES) {
      toast.error(
        file.type === "application/pdf" ? "El PDF pesa más de 4 MB" : "La foto pesa demasiado, probá con una captura",
      );
      return;
    }
    onFile(file);
  };

  return (
    <button
      type="button"
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void pick(e.dataTransfer.files[0]);
      }}
      className={cn(
        "flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-dashed px-6 py-12 text-center transition md:py-16",
        over ? "border-brand bg-brand/5" : "border-border hover:bg-muted/40",
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted">
        {over ? <Upload className="size-6" /> : <FileText className="size-6" />}
      </span>
      <span className="font-medium md:hidden">Tocá para elegir el PDF, una foto o una captura del resumen</span>
      <span className="hidden font-medium md:inline">
        Arrastrá el PDF o la foto del resumen, o hacé clic para elegirlo
      </span>
      <span className="text-sm text-muted-foreground">PDF (hasta 4 MB, sin contraseña) o foto</span>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </button>
  );
}
