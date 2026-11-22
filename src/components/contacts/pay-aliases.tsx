"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { payAliasKind, type PayAlias } from "@/lib/domain/contact-info";

/** Alias/CBU de una persona, cada uno con su botón para copiarlo. */
export function PayAliasList({ aliases }: { aliases: PayAlias[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      toast.success("Copiado");
      setTimeout(() => setCopied((v) => (v === value ? null : v)), 1500);
    } catch {
      toast.error("No se pudo copiar");
    }
  };
  return (
    <div className="divide-y">
      {aliases.map((a) => (
        <div key={a.value} className="flex items-center gap-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm">{a.value}</div>
            <div className="text-xs text-muted-foreground">
              {payAliasKind(a.value)}
              {a.label ? ` · ${a.label}` : ""}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => copy(a.value)}>
            {copied === a.value ? <Check className="mr-1 size-4" /> : <Copy className="mr-1 size-4" />}
            Copiar
          </Button>
        </div>
      ))}
    </div>
  );
}
