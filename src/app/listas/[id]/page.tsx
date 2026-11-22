"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  ChevronDown,
  FolderPlus,
  LogOut,
  MoreVertical,
  Pencil,
  Plus,
  Share2,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ENTER, enterDelay } from "@/components/motion/enter";
import { BudgetBar } from "@/components/lists/budget-bar";
import { ItemForm } from "@/components/lists/item-form";
import { ItemRow, type ItemRowActions } from "@/components/lists/item-row";
import { NodeCard, NodeIcon } from "@/components/lists/node-card";
import { NodeForm } from "@/components/lists/node-form";
import { ShareForm } from "@/components/lists/share-form";
import { useListTree } from "@/components/lists/use-list-tree";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/api";
import {
  addItem,
  ancestorsOf,
  canEdit,
  childrenOf,
  deleteItem,
  deleteNodeTree,
  descendantsOf,
  dueLabel,
  isOverdue,
  myRole,
  nodeSummary,
  personName,
  roleLabel,
  setItemExpense,
  sortedItems,
  toggleItem,
  todayYMD,
  type ListItem,
  type ListNodeKind,
} from "@/lib/domain/lists";
import { cn } from "@/lib/utils";

export default function ListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { user } = useAuth();
  const { index, byId, loading, rates } = useListTree();
  const [creating, setCreating] = useState<ListNodeKind | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [editingItem, setEditingItem] = useState<ListItem | null>(null);
  const [expenseFor, setExpenseFor] = useState<ListItem | null>(null);
  const [newItem, setNewItem] = useState("");
  const [showDone, setShowDone] = useState(false);

  const node = byId.get(id);

  if (loading && !node) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  if (!node || !user) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="-ml-2 rounded-xl" render={<Link href="/listas" />} nativeButton={false}>
          <ArrowLeft className="size-4" /> Listas
        </Button>
        <Card className="rounded-3xl">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Esta lista no existe o ya no la compartís.
          </CardContent>
        </Card>
      </div>
    );
  }

  const role = myRole(node, { uid: user.uid, email: user.email });
  const editable = canEdit(role);
  const isOwner = node.ownerUid === user.uid;
  const ancestors = ancestorsOf(byId, node);
  const parent = ancestors.at(-1) ?? null;
  const backHref = parent ? `/listas/${parent.id}` : "/listas";
  const summary = nodeSummary(node, index, rates);
  const due = dueLabel(node.dueDate);
  const allDone = summary.items.total > 0 && summary.items.done === summary.items.total;
  const others = node.members.filter((m) => m.uid !== user.uid && m.email.toLowerCase() !== user.email?.toLowerCase());
  const me = { uid: user.uid, name: user.displayName ?? null };

  const items = sortedItems(node);
  const pending = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const kids = childrenOf(index, node.id);

  const addTitles = async (raw: string) => {
    const titles = raw
      .split(/\n+/)
      .map((t) => t.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter(Boolean);
    if (!titles.length) return;
    try {
      for (const title of titles) await addItem(node.id, user.uid, { title });
      if (titles.length > 1) toast.success(`Agregué ${titles.length} ítems`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo agregar");
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = newItem;
    setNewItem("");
    await addTitles(raw);
  };

  const itemActions: ItemRowActions = {
    onToggle: (item, d) => {
      toggleItem(node.id, item.id, d, me).catch(() => toast.error("No se pudo guardar"));
    },
    onEdit: setEditingItem,
    onAddExpense: setExpenseFor,
    onUnlinkExpense: async (item) => {
      if (!confirm("¿Desvincular tu gasto de este ítem? El gasto sigue en tus movimientos.")) return;
      await setItemExpense(node.id, item.id, me, null, item.expenses?.[user.uid]?.transactionId).catch(() =>
        toast.error("No se pudo desvincular"),
      );
    },
    onDelete: async (item) => {
      const withExpense = Object.keys(item.expenses ?? {}).length > 0;
      if (
        withExpense &&
        !confirm(`¿Eliminar "${item.title}"? Los gastos que tiene cargados siguen en los movimientos de cada uno.`)
      )
        return;
      await deleteItem(node.id, item.id).catch(() => toast.error("No se pudo eliminar"));
    },
  };

  const removeNode = async () => {
    const inside = descendantsOf(index, node.id).length;
    const what = node.kind === "group" ? "el grupo" : "la lista";
    const msg = [
      `¿Eliminar ${what} "${node.title}"${inside ? ` y ${inside === 1 ? "lo que tiene adentro" : `las ${inside} listas/grupos de adentro`}` : ""}?`,
      others.length ? "También deja de estar para las personas con las que la compartiste." : "",
      summary.spent > 0 ? "Los gastos cargados siguen en los movimientos." : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!confirm(msg)) return;
    try {
      await deleteNodeTree(node, index);
      toast.success("Eliminada");
      router.push(backHref);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar");
    }
  };

  const leave = async () => {
    if (!confirm(`¿Salir de "${node.title}"? Deja de aparecerte (y todo lo de adentro).`)) return;
    try {
      const r = await apiFetch("/api/lists/leave", { method: "POST", body: JSON.stringify({ nodeId: node.id }) });
      const data = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) throw new Error(data?.error);
      toast.success("Listo");
      router.push("/listas");
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "No se pudo completar");
    }
  };

  const today = todayYMD();

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <Button variant="ghost" size="sm" className="-ml-2 rounded-xl" render={<Link href={backHref} />} nativeButton={false}>
            <ArrowLeft className="size-4" /> {parent ? parent.title : "Listas"}
          </Button>
          {ancestors.length > 1 && (
            <span className="truncate text-xs">
              {ancestors
                .slice(0, -1)
                .map((a) => a.title)
                .join(" › ")}
            </span>
          )}
        </div>

        <div className="flex items-start gap-3">
          <NodeIcon node={node} className="size-12 text-2xl" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight">{node.title}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {node.kind === "list" && summary.items.total > 0 && (
                <span>
                  {summary.items.done}/{summary.items.total} hechos
                </span>
              )}
              {due && (
                <span
                  className={cn("inline-flex items-center gap-1", isOverdue(node.dueDate, today) && !allDone && "text-destructive")}
                >
                  <CalendarClock className="size-3" /> {due}
                </span>
              )}
              {others.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3" />
                  {isOwner
                    ? `Con ${others.map(personName).join(", ")}`
                    : `De ${personName({ displayName: node.ownerDisplayName, email: node.ownerEmail })} · ${role ? roleLabel(role) : ""}`}
                </span>
              )}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Opciones" />}>
              <MoreVertical className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {editable && (
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <Pencil className="mr-2 size-4" /> Editar
                </DropdownMenuItem>
              )}
              {isOwner && (
                <DropdownMenuItem onClick={() => setSharing(true)}>
                  <Share2 className="mr-2 size-4" /> Compartir
                </DropdownMenuItem>
              )}
              {!isOwner && (
                <DropdownMenuItem onClick={leave}>
                  <LogOut className="mr-2 size-4" /> Salir de la lista
                </DropdownMenuItem>
              )}
              {editable && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={removeNode}>
                    <Trash2 className="mr-2 size-4" /> Eliminar
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {node.notes && <p className="whitespace-pre-line text-sm text-muted-foreground">{node.notes}</p>}
      </div>

      {(node.budget || summary.spent > 0 || summary.projected > 0) && (
        <Card className="rounded-2xl">
          <CardContent className="py-4">
            <BudgetBar
              spent={summary.spent}
              budget={node.budget}
              currency={node.currency}
              projected={summary.projected}
              missing={summary.missing}
            />
          </CardContent>
        </Card>
      )}

      {node.kind === "group" && (
        <section className="space-y-2">
          {kids.length === 0 ? (
            <Card className="rounded-3xl">
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Este grupo está vacío. Sumale listas (ej. «Invitados», «Compras») o más grupos.
              </CardContent>
            </Card>
          ) : (
            kids.map((k, i) => (
              <NodeCard
                key={k.id}
                node={k}
                index={index}
                rates={rates}
                myUid={user.uid}
                className={ENTER}
                style={enterDelay(i)}
              />
            ))
          )}
          {editable && (
            <div className="flex gap-2 pt-1">
              <Button className="flex-1 rounded-xl bg-brand-grad text-white hover:opacity-95" onClick={() => setCreating("list")}>
                <Plus className="size-4" /> Lista adentro
              </Button>
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setCreating("group")}>
                <FolderPlus className="size-4" /> Grupo adentro
              </Button>
            </div>
          )}
        </section>
      )}

      {node.kind === "list" && (
        <section className="space-y-3">
          {editable && (
            <form onSubmit={add} className="flex gap-2">
              <Input
                className="h-12 flex-1 text-base"
                placeholder="Agregar… (ej. leche, Juan Pérez)"
                value={newItem}
                maxLength={2000}
                onChange={(e) => setNewItem(e.target.value)}
                onPaste={(e) => {
                  // Pegar una lista (varias líneas) la agrega entera, un ítem por línea.
                  const text = e.clipboardData.getData("text");
                  if (text.trim().includes("\n")) {
                    e.preventDefault();
                    void addTitles(text);
                  }
                }}
              />
              <Button type="submit" className="h-12 rounded-xl bg-brand-grad px-4 text-white hover:opacity-95" disabled={!newItem.trim()}>
                <Plus className="size-5" />
                <span className="sr-only">Agregar</span>
              </Button>
            </form>
          )}

          {items.length === 0 ? (
            <Card className="rounded-3xl">
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {editable ? "La lista está vacía. Escribí arriba lo primero." : "La lista está vacía."}
              </CardContent>
            </Card>
          ) : (
            <>
              {pending.length > 0 && (
                <Card className="overflow-hidden rounded-2xl py-0">
                  <div className="divide-y">
                    {pending.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        currency={node.currency}
                        myUid={user.uid}
                        editable={editable}
                        actions={itemActions}
                      />
                    ))}
                  </div>
                </Card>
              )}
              {pending.length === 0 && (
                <p className="px-1 text-sm text-muted-foreground">¡Todo hecho! 🎉</p>
              )}
              {done.length > 0 && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setShowDone((v) => !v)}
                    className="flex items-center gap-1 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    <ChevronDown className={cn("size-3.5 transition-transform", !showDone && "-rotate-90")} />
                    Hechos · {done.length}
                  </button>
                  {showDone && (
                    <Card className="overflow-hidden rounded-2xl py-0">
                      <div className="divide-y">
                        {done.map((item) => (
                          <ItemRow
                            key={item.id}
                            item={item}
                            currency={node.currency}
                            myUid={user.uid}
                            editable={editable}
                            actions={itemActions}
                          />
                        ))}
                      </div>
                    </Card>
                  )}
                </div>
              )}
            </>
          )}
          {!editable && (
            <p className="px-1 text-[11px] text-muted-foreground">Te la compartieron para ver: no podés cambiarla.</p>
          )}
        </section>
      )}

      {/* Nuevo grupo/lista adentro */}
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
                parent={node}
                onDone={(newId) => {
                  setCreating(null);
                  router.push(`/listas/${newId}`);
                }}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Editar este nodo */}
      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>{node.kind === "group" ? "Editar grupo" : "Editar lista"}</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {editing && <NodeForm key={node.id} node={node} onDone={() => setEditing(false)} />}
          </div>
        </SheetContent>
      </Sheet>

      {/* Compartir */}
      <Sheet open={sharing} onOpenChange={setSharing}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Compartir “{node.title}”</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {sharing && <ShareForm node={node} ancestors={ancestors} onDone={() => setSharing(false)} />}
          </div>
        </SheetContent>
      </Sheet>

      {/* Editar ítem */}
      <Sheet open={!!editingItem} onOpenChange={(o) => !o && setEditingItem(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Editar ítem</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {editingItem && (
              <ItemForm
                key={editingItem.id}
                listId={node.id}
                item={editingItem}
                currency={node.currency}
                onDone={() => setEditingItem(null)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Cargar el gasto de un ítem */}
      <Sheet open={!!expenseFor} onOpenChange={(o) => !o && setExpenseFor(null)}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Gasto de “{expenseFor?.title}”</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-6 pt-2">
            {expenseFor && (
              <TransactionForm
                key={expenseFor.id}
                initial={{
                  description: expenseFor.title,
                  date: today,
                  amount: expenseFor.estimatedAmount ?? null,
                  currency: node.currency,
                }}
                onSaved={async (info) => {
                  await setItemExpense(node.id, expenseFor.id, me, {
                    transactionId: info.transactionId,
                    amount: info.amount,
                    currency: info.currency,
                    byName: user.displayName ?? null,
                    sharedExpenseId: info.splitId,
                  });
                }}
                onSubmitted={() => setExpenseFor(null)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
