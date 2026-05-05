"use client";

import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePendingApprovalsAsOwner } from "@/hooks/use-data";

export function ApprovalsBanner() {
  const { data: approvals } = usePendingApprovalsAsOwner();
  if (approvals.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3 text-sm">
        <div className="flex size-9 items-center justify-center rounded-xl bg-brand-grad text-white">
          <ClipboardCheck className="size-4" />
        </div>
        <div>
          <div className="font-medium">
            {approvals.length}{" "}
            {approvals.length === 1
              ? "gasto pendiente de aprobación"
              : "gastos pendientes de aprobación"}
          </div>
          <div className="text-xs text-muted-foreground">
            Cargados desde tus cuentas compartidas.
          </div>
        </div>
      </div>
      <Button size="sm" variant="outline" render={<Link href="/aprobaciones" />} nativeButton={false}>
        Revisar
      </Button>
    </div>
  );
}
