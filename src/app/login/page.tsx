"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Sparkles, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import {
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
} from "@/lib/firebase/auth";

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [user, loading, router]);

  const handle = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error";
      setError(msg.replace("Firebase: ", ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <div className="hidden flex-col justify-between bg-brand-grad p-10 text-white md:flex">
        <div className="flex items-center gap-2">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <Wallet className="size-5" />
          </div>
          <span className="text-base font-semibold tracking-tight">Saldo</span>
        </div>
        <div className="space-y-3">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] font-medium uppercase tracking-wider backdrop-blur">
            <Sparkles className="size-3" />
            Tu balance, claro
          </div>
          <h2 className="text-3xl font-bold tracking-tight">
            Llevá el control de tus gastos sin vueltas.
          </h2>
          <p className="max-w-md text-sm text-white/80">
            Anotá ingresos, gastos y compras en cuotas con tarjeta. Mirá el balance del mes
            de un vistazo.
          </p>
        </div>
        <div className="text-xs text-white/60">© Saldo</div>
      </div>

      <div className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1 md:hidden">
            <div className="flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-xl bg-brand-grad text-white">
                <Wallet className="size-4" />
              </div>
              <span className="text-base font-bold">Saldo</span>
            </div>
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Iniciá sesión</h1>
            <p className="text-sm text-muted-foreground">
              Llevá tu balance personal mes a mes.
            </p>
          </div>

          <Button
            variant="outline"
            className="w-full h-12 gap-2"
            onClick={() => handle(signInWithGoogle)}
            disabled={busy}
          >
            <GoogleIcon /> Continuar con Google
          </Button>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />o<div className="h-px flex-1 bg-border" />
          </div>

          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Ingresar</TabsTrigger>
              <TabsTrigger value="signup">Registrarme</TabsTrigger>
            </TabsList>
            <TabsContent value="signin" className="space-y-3 pt-3">
              <EmailField value={email} onChange={setEmail} />
              <PasswordField value={password} onChange={setPassword} />
              <Button
                className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
                disabled={busy || !email || !password}
                onClick={() => handle(() => signInWithEmail(email, password))}
              >
                Ingresar
              </Button>
            </TabsContent>
            <TabsContent value="signup" className="space-y-3 pt-3">
              <EmailField value={email} onChange={setEmail} />
              <PasswordField value={password} onChange={setPassword} />
              <Button
                className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
                disabled={busy || !email || password.length < 6}
                onClick={() => handle(() => signUpWithEmail(email, password))}
              >
                Crear cuenta
              </Button>
            </TabsContent>
          </Tabs>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function EmailField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="email">Email</Label>
      <Input
        id="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        className="h-12"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="password">Contraseña</Label>
      <Input
        id="password"
        type="password"
        autoComplete="current-password"
        className="h-12"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.07 5.07 0 0 1-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.56-2.77c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.28-1.93-6.15-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.85 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.45.34-2.11V7.05H2.18a11 11 0 0 0 0 9.9l3.67-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.2 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.67 2.84C6.72 7.3 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}
