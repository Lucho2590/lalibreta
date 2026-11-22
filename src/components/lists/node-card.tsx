"use client";

import Link from "next/link";
import { CalendarClock, ChevronRight, Folder, ListChecks, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import {
  childrenLabel,
  dueLabel,
  isOverdue,
  nodeSummary,
  personName,
  type ListNode,
} from "@/lib/domain/list-model";
import type { FxRatesMap } from "@/lib/domain/balance";
import { cn } from "@/lib/utils";
import { BudgetBar } from "./budget-bar";

/** Icono del nodo: su emoji o, si no tiene, carpeta (grupo) / check (lista). */
export function NodeIcon({ node, className }: { node: Pick<ListNode, "kind" | "emoji">; className?: string }) {
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl text-lg",
        node.kind === "group" ? "bg-primary/10 text-primary" : "bg-muted text-foreground",
        className,
      )}
    >
      {node.emoji ? (
        <span aria-hidden>{node.emoji}</span>
      ) : node.kind === "group" ? (
        <Folder className="size-5" />
      ) : (
        <ListChecks className="size-5" />
      )}
    </div>
  );
}

/** Personas con acceso (sin mí), en avatares chiquitos. */
export function MemberAvatars({ node, myUid, max = 3 }: { node: ListNode; myUid: string; max?: number }) {
  const others = node.members.filter((m) => m.uid !== myUid);
  if (others.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1" title={others.map(personName).join(", ")}>
      <span className="flex -space-x-1.5">
        {others.slice(0, max).map((m) => (
          <Avatar key={m.email} className="size-5 ring-2 ring-background">
            {m.photoURL && <AvatarImage src={m.photoURL} alt="" />}
            <AvatarFallback className="text-[9px]">{personName(m)[0]?.toUpperCase()}</AvatarFallback>
          </Avatar>
        ))}
      </span>
      {others.length > max && <span className="text-[11px] text-muted-foreground">+{others.length - max}</span>}
    </span>
  );
}

export function NodeCard({
  node,
  index,
  rates,
  myUid,
  showOwner,
  className,
  style,
}: {
  node: ListNode;
  index: Map<string, ListNode[]>;
  rates: FxRatesMap | null;
  myUid: string;
  /** Mostrar "De Fulano" si no es mía. */
  showOwner?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const s = nodeSummary(node, index, rates);
  const due = dueLabel(node.dueDate);
  const overdue = isOverdue(node.dueDate) && !(s.items.total > 0 && s.items.done === s.items.total);
  const subtitle =
    node.kind === "group"
      ? `${childrenLabel(s)}${s.items.total ? ` · ${s.items.done}/${s.items.total} hechos` : ""}`
      : s.items.total
        ? `${s.items.done}/${s.items.total} hechos`
        : "Sin ítems todavía";

  return (
    <Link href={`/listas/${node.id}`} className={cn("block", className)} style={style}>
      <Card className="rounded-2xl transition-colors hover:bg-muted/40">
        <CardContent className="space-y-2.5 py-3.5">
          <div className="flex items-center gap-3">
            <NodeIcon node={node} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{node.title}</div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>{subtitle}</span>
                {due && (
                  <span className={cn("inline-flex items-center gap-1", overdue && "text-destructive")}>
                    <CalendarClock className="size-3" /> {due}
                  </span>
                )}
                {showOwner && node.ownerUid !== myUid && (
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3" /> De {personName({ displayName: node.ownerDisplayName, email: node.ownerEmail })}
                  </span>
                )}
              </div>
            </div>
            <MemberAvatars node={node} myUid={myUid} />
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </div>
          {s.items.total > 0 && !node.budget && s.spent <= 0 && (
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/50 transition-[width] duration-700 ease-out motion-reduce:transition-none"
                style={{ width: `${(s.items.done / s.items.total) * 100}%` }}
              />
            </div>
          )}
          <BudgetBar spent={s.spent} budget={node.budget} currency={node.currency} projected={s.projected} compact />
        </CardContent>
      </Card>
    </Link>
  );
}
