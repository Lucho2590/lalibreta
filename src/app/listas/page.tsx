"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, ListChecks, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ENTER, enterDelay } from "@/components/motion/enter";
import { NodeCard } from "@/components/lists/node-card";
import { NodeForm } from "@/components/lists/node-form";
import { useListTree } from "@/components/lists/use-list-tree";
import { useAuth } from "@/hooks/use-auth";
import { rootsOf, type ListNodeKind } from "@/lib/domain/list-model";
import { cn } from "@/lib/utils";

export default function ListasPage() {
  const { user } = useAuth();
  const router = useRouter();
  const { index, loading, error, rates, nodes } = useListTree();
  const [creating, setCreating] = useState<ListNodeKind | null>(null);

  const roots = rootsOf(index);
  const mine = roots.filter((n) => n.ownerUid === user?.uid);
  const shared = roots.filter((n) => n.ownerUid !== user?.uid);

  const renderCards = (list: typeof roots, offset = 0) =>
    list.map((n, i) => (
      <NodeCard
        key={n.id}
        node={n}
        index={index}
        rates={rates}
        myUid={user!.uid}
        showOwner
        className={ENTER}
        style={enterDelay(i + offset)}
      />
    ));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Listas</h1>
          <p className="text-sm text-muted-foreground">Compras, invitados, pendientes… solas o en grupos</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="rounded-xl" onClick={() => setCreating("group")}>
            <FolderPlus className="size-4" /> <span className="hidden sm:inline">Nuevo grupo</span>
            <span className="sm:hidden">Grupo</span>
          </Button>
          <Button className="bg-brand-grad text-white hover:opacity-95" onClick={() => setCreating("list")}>
            <Plus className="size-4" /> <span className="hidden sm:inline">Nueva lista</span>
            <span className="sm:hidden">Lista</span>
          </Button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!loading && error && nodes.length === 0 && (
        <Card className="rounded-3xl border-destructive/30">
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No pudimos cargar tus listas</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Probá recargar la página en un rato. Si sigue pasando, avisanos.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && roots.length === 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-16 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
              <ListChecks className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Todavía no tenés listas</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Armá la lista del super, los invitados de tu cumple o lo que necesites. Agrupalas (ej. «Mi
              cumple» con «Invitados» y «Compras»), ponele un máximo a gastar y compartilas para que otros
              las vean o las editen. También se las podés pedir al bot de WhatsApp.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setCreating("group")}>
                <FolderPlus className="size-4" /> Crear un grupo
              </Button>
              <Button size="sm" className="rounded-xl bg-brand-grad text-white hover:opacity-95" onClick={() => setCreating("list")}>
                <Plus className="size-4" /> Crear una lista
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && mine.length > 0 && <div className="space-y-2">{renderCards(mine)}</div>}

      {!loading && shared.length > 0 && (
        <section className={cn("space-y-2", ENTER)}>
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Compartidas conmigo · {shared.length}
          </h2>
          {renderCards(shared, mine.length)}
        </section>
      )}

      <Sheet open={!!creating} onOpenChange={(o) => !o && setCreating(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>{creating === "group" ? "Nuevo grupo" : "Nueva lista"}</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {creating && (
              <NodeForm
                key={creating}
                kind={creating}
                onDone={(id) => {
                  setCreating(null);
                  router.push(`/listas/${id}`);
                }}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
