"use client";

import { Check, MapPin, MoreVertical, Pencil, Receipt, Split, Trash2, Unlink, UserMinus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { companions, participantName, type Activity, type ActivityParticipant } from "@/lib/domain/activity-model";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ActivityCardActions {
  onRespond: (a: Activity, response: "accepted" | "rejected") => void;
  onEdit: (a: Activity) => void;
  onDelete: (a: Activity) => void;
  /** split=true: "lo pagué yo y lo divido con los que van". */
  onAddExpense: (a: Activity, split: boolean) => void;
  onUnlinkExpense: (a: Activity) => void;
}

const goingOrInvited = (p: ActivityParticipant) => p.status !== "rejected";

export function ActivityCard({
  activity: a,
  me,
  myUid,
  past,
  actions,
}: {
  activity: Activity;
  me: ActivityParticipant;
  myUid: string;
  past?: boolean;
  actions: ActivityCardActions;
}) {
  const isOwner = me.status === "owner";
  const going = isOwner || me.status === "accepted";
  const others = companions(a, me).filter(goingOrInvited);
  const myExpense = a.expenses?.[myUid];
  const othersExpenses = Object.entries(a.expenses ?? {})
    .filter(([uid]) => uid !== myUid)
    .map(([uid, e]) => ({ e, who: a.participants.find((p) => p.uid === uid) }));
  const canSplit = others.some((p) => p.status === "owner" || p.status === "accepted");

  return (
    <Card className={cn("rounded-2xl", me.status === "pending" && "border-primary/40 bg-primary/[0.03]")}>
      <CardContent className="flex gap-3 py-3.5">
        <div className="w-12 shrink-0 pt-0.5 text-center">
          {a.time ? (
            <span className="text-sm font-semibold tabular-nums">{a.time}</span>
          ) : (
            <span className="text-[11px] leading-tight text-muted-foreground">Todo el día</span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm font-semibold", past && "text-muted-foreground")}>{a.title}</div>
              {a.location && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="size-3 shrink-0" />
                  <span className="truncate">{a.location}</span>
                </div>
              )}
            </div>
            {(isOwner || me.status === "accepted" || myExpense) && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon" className="-mr-2 -mt-1.5 size-8" aria-label="Opciones" />}
                >
                  <MoreVertical className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {isOwner && (
                    <DropdownMenuItem onClick={() => actions.onEdit(a)}>
                      <Pencil className="mr-2 size-4" /> Editar
                    </DropdownMenuItem>
                  )}
                  {myExpense && (
                    <DropdownMenuItem onClick={() => actions.onUnlinkExpense(a)}>
                      <Unlink className="mr-2 size-4" /> Desvincular mi gasto
                    </DropdownMenuItem>
                  )}
                  {me.status === "accepted" && (
                    <DropdownMenuItem onClick={() => actions.onRespond(a, "rejected")}>
                      <UserMinus className="mr-2 size-4" /> Ya no voy
                    </DropdownMenuItem>
                  )}
                  {isOwner && (
                    <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(a)}>
                      <Trash2 className="mr-2 size-4" /> {others.length > 0 ? "Cancelar actividad" : "Eliminar"}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {(others.length > 0 || !isOwner) && (
            <div className="flex items-start gap-1 text-xs text-muted-foreground">
              <Users className="mt-0.5 size-3 shrink-0" />
              <span>
                {!isOwner && <>Organiza {a.ownerDisplayName || a.ownerEmail.split("@")[0]}. </>}
                {others.filter((p) => p.status !== "owner").length > 0 && (
                  <>
                    Con{" "}
                    {others
                      .filter((p) => p.status !== "owner")
                      .map((p) => `${participantName(p)}${p.status === "pending" ? " (invitado)" : ""}`)
                      .join(", ")}
                  </>
                )}
              </span>
            </div>
          )}

          {a.notes && <p className="whitespace-pre-line text-xs text-muted-foreground">{a.notes}</p>}

          {me.status === "pending" && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs font-medium">¿Vas?</span>
              <Button size="sm" className="h-8 bg-brand-grad text-white" onClick={() => actions.onRespond(a, "accepted")}>
                <Check className="size-3.5" /> Voy
              </Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => actions.onRespond(a, "rejected")}>
                No puedo
              </Button>
            </div>
          )}

          {going && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {myExpense ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
                  <Check className="size-3" /> Gasto cargado: {formatMoney(myExpense.amount, myExpense.currency)}
                  {myExpense.sharedExpenseId && " · dividido"}
                </span>
              ) : (
                <>
                  {a.estimatedAmount ? (
                    <span className="text-xs text-muted-foreground">
                      Estimado {formatMoney(a.estimatedAmount, a.currency ?? "ARS")}
                    </span>
                  ) : null}
                  <Button size="sm" variant="outline" className="h-8" onClick={() => actions.onAddExpense(a, false)}>
                    <Receipt className="size-3.5" /> Cargar gasto
                  </Button>
                  {canSplit && (a.currency ?? "ARS") === "ARS" && (
                    <Button size="sm" variant="outline" className="h-8" onClick={() => actions.onAddExpense(a, true)}>
                      <Split className="size-3.5" /> Pagué yo, dividir
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {othersExpenses.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              {othersExpenses
                .map(({ e, who }) => `${who ? participantName(who) : "Alguien"} cargó ${formatMoney(e.amount, e.currency)}${e.sharedExpenseId ? " (dividido)" : ""}`)
                .join(" · ")}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
