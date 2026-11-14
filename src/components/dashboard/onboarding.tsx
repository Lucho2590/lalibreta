"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircle2, CreditCard, MessageCircle, Wallet } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useAccounts, useRecurring } from "@/hooks/use-data";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/utils";

interface WaStatus {
  agentName: string | null;
  linked: boolean;
  botNumber: string | null;
}

const MAIN_ACCOUNT_MSG =
  "mi cuenta principal es el Banco Galicia, ahí cobro. Tengo 850000 pesos";
const SALARY_MSG = "cobro 1500000 pesos de sueldo todos los 5";
const SKIP_KEY = "onboarding-salary-skipped";

/**
 * Onboarding: (1) conectar WhatsApp con el agente, (2) crear la primera
 * cuenta. Se oculta solo cuando los dos pasos están hechos.
 */
export function Onboarding() {
  const { user } = useAuth();
  const { data: accounts, loading: accountsLoading } = useAccounts();
  const { data: recurring, loading: recurringLoading } = useRecurring();
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [salarySkipped, setSalarySkipped] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(SKIP_KEY) === "1",
  );

  // Estado de WhatsApp; mientras no esté vinculado, se reconsulta cada 5 s
  // para marcar el paso apenas el usuario manda el código.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const s = await apiJson<WaStatus>("/api/whatsapp/status");
        if (cancelled) return;
        setStatus(s);
        if (!s.linked) timer = setTimeout(load, 5000);
      } catch (err) {
        console.warn("[onboarding] status falló", err);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user]);

  if (!status || accountsLoading || recurringLoading) return null;
  const linked = status.linked;
  const hasMain = accounts.some((a) => a.isMain && a.active !== false);
  const hasIncome = recurring.some((r) => r.kind === "income");
  const salaryDone = hasIncome || salarySkipped;
  if (linked && hasMain && salaryDone) return null;

  const agent = status.agentName ?? "tu agente";
  const wa = (text: string) =>
    status.botNumber
      ? `https://wa.me/${status.botNumber.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`
      : null;
  const skipSalary = () => {
    window.localStorage.setItem(SKIP_KEY, "1");
    setSalarySkipped(true);
  };

  return (
    <Card className="overflow-hidden rounded-3xl">
      <div className="bg-brand-grad px-6 py-5 text-white">
        <h2 className="text-lg font-bold">¡Bienvenido a La Libreta! 👋</h2>
        <p className="text-sm opacity-90">
          Tu agente de cuentas es <span className="font-semibold">{agent}</span>. Tres pasos y
          arrancás.
        </p>
      </div>
      <CardContent className="divide-y p-0">
        <Step
          n={1}
          done={linked}
          icon={<MessageCircle className="size-4" />}
          title={`Conectá tu WhatsApp con ${agent}`}
          description="Vas a poder cargar gastos escribiendo, con audios, fotos de tickets o el PDF del resumen de la tarjeta."
        >
          {!linked && (
            <Link
              href="/whatsapp"
              className={cn(buttonVariants(), "gap-2 rounded-xl bg-brand-grad text-white hover:opacity-95")}
            >
              <MessageCircle className="size-4" /> Conectar WhatsApp
            </Link>
          )}
        </Step>
        <Step
          n={2}
          done={hasMain}
          icon={<CreditCard className="size-4" />}
          title="Creá tu cuenta principal"
          description={
            linked
              ? `Es donde cobrás (en pesos y/o dólares). Contale a ${agent}: "${MAIN_ACCOUNT_MSG}".`
              : "Es donde cobrás: tu banco, en pesos y/o dólares, con el saldo que tenés hoy."
          }
        >
          <div className="flex flex-wrap gap-2">
            {linked && wa(MAIN_ACCOUNT_MSG) && (
              <a
                href={wa(MAIN_ACCOUNT_MSG)!}
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants(), "gap-2 rounded-xl bg-[#25D366] text-white hover:opacity-95")}
              >
                <MessageCircle className="size-4" /> Contárselo a {agent}
              </a>
            )}
            <Link href="/cuentas" className={cn(buttonVariants({ variant: "outline" }), "rounded-xl")}>
              Crear desde la app
            </Link>
          </div>
        </Step>
        <Step
          n={3}
          done={salaryDone}
          icon={<Wallet className="size-4" />}
          title={`Contale a ${agent} cuánto cobrás (opcional)`}
          description={`Así el balance del mes tiene sentido desde el primer día. Ej: "${SALARY_MSG}".`}
        >
          <div className="flex flex-wrap gap-2">
            {linked && wa(SALARY_MSG) && (
              <a
                href={wa(SALARY_MSG)!}
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants(), "gap-2 rounded-xl bg-[#25D366] text-white hover:opacity-95")}
              >
                <MessageCircle className="size-4" /> Contárselo a {agent}
              </a>
            )}
            <Link href="/fijos" className={cn(buttonVariants({ variant: "outline" }), "rounded-xl")}>
              Cargarlo en Fijos
            </Link>
            <button
              type="button"
              onClick={skipSalary}
              className={cn(buttonVariants({ variant: "ghost" }), "rounded-xl text-muted-foreground")}
            >
              Omitir
            </button>
          </div>
        </Step>
      </CardContent>
    </Card>
  );
}

function Step({
  n,
  done,
  icon,
  title,
  description,
  children,
}: {
  n: number;
  done: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-4 px-6 py-5", done && "opacity-60")}>
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-2xl",
          done ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-foreground",
        )}
      >
        {done ? <CheckCircle2 className="size-5" /> : icon}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <p className="text-sm font-semibold">
            <span className="text-muted-foreground">Paso {n} · </span>
            {title}
          </p>
          <p className="text-xs text-muted-foreground">{done ? "¡Listo!" : description}</p>
        </div>
        {!done && children}
      </div>
    </div>
  );
}
