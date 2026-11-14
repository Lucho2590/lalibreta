"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAdminToken, unlockAdmin } from "@/lib/admin-client";
import { cn } from "@/lib/utils";

const TAPS = 8;
const MAX_GAP_MS = 1200;

/**
 * Envuelve el logo: 8 toques seguidos abren el PIN del panel de administrador.
 * (El server además exige que el usuario sea admin.)
 */
export function AdminLogoTap({ children, className }: { children: React.ReactNode; className?: string }) {
  const router = useRouter();
  const taps = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  const [open, setOpen] = useState(false);

  const onTap = () => {
    const now = Date.now();
    const t = taps.current;
    t.count = now - t.last > MAX_GAP_MS ? 1 : t.count + 1;
    t.last = now;
    if (t.count < TAPS) return;
    t.count = 0;
    if (getAdminToken()) router.push("/admin");
    else setOpen(true);
  };

  return (
    <>
      <div onClick={onTap} className={cn("select-none", className)} style={{ WebkitTapHighlightColor: "transparent" }}>
        {children}
      </div>
      <PinDialog
        open={open}
        onOpenChange={setOpen}
        onUnlocked={() => {
          setOpen(false);
          router.push("/admin");
        }}
      />
    </>
  );
}

export function PinDialog({
  open,
  onOpenChange,
  onUnlocked,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUnlocked: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    const r = await unlockAdmin(value);
    setBusy(false);
    if (r.ok) {
      setPin("");
      onUnlocked();
    } else {
      setPin("");
      setError(r.error);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) {
          setPin("");
          setError(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-xs">
        <DialogHeader className="items-center text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-muted">
            <Lock className="size-5" />
          </span>
          <DialogTitle>Administración</DialogTitle>
          <DialogDescription>Ingresá el PIN de 4 dígitos.</DialogDescription>
        </DialogHeader>
        <label className="relative mx-auto flex gap-2" aria-label="PIN">
          {Array.from({ length: 4 }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "flex size-12 items-center justify-center rounded-xl border text-xl font-semibold",
                i === pin.length && !busy ? "border-primary ring-2 ring-primary/30" : "",
                error ? "border-destructive" : "",
              )}
            >
              {pin[i] ? "•" : ""}
            </span>
          ))}
          <input
            autoFocus
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={4}
            value={pin}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 4);
              setPin(v);
              setError(null);
              if (v.length === 4) void submit(v);
            }}
            className="absolute inset-0 opacity-0"
          />
        </label>
        <div className="h-5 text-center text-sm">
          {busy ? (
            <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
