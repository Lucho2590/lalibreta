"use client";

import { useState } from "react";
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useCategories } from "@/hooks/use-data";
import { categoriesCollectionPath } from "@/lib/domain/seed";
import { db } from "@/lib/firebase/client";
import type { CategoryKind } from "@/lib/domain/types";
import { CATEGORY_ICONS, CategoryIcon } from "@/components/category-icon";

export default function CategoriesPage() {
  const { user } = useAuth();
  const { data: categories, loading } = useCategories();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string>(CATEGORY_ICONS[0].id);
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name.trim()) return;
    setBusy(true);
    try {
      await addDoc(collection(db, categoriesCollectionPath(user.uid)), {
        name: name.trim(),
        icon,
        color: "",
        kind,
        createdAt: Timestamp.now(),
      });
      setName("");
      setIcon(CATEGORY_ICONS[0].id);
      setOpen(false);
      toast.success("Categoría creada");
    } catch (err) {
      toast.error("No se pudo crear");
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!user) return;
    if (!confirm("¿Eliminar categoría? Los movimientos existentes la conservarán.")) return;
    try {
      await deleteDoc(doc(db, `${categoriesCollectionPath(user.uid)}/${id}`));
      toast.success("Categoría eliminada");
    } catch (err) {
      toast.error("No se pudo eliminar");
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Categorías</h1>
          <p className="text-sm text-muted-foreground">
            Organizá tus gastos e ingresos por concepto
          </p>
        </div>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={<Button className="bg-brand-grad text-white hover:opacity-95" />}
          >
            <Plus className="mr-1 size-4" /> Nueva
          </SheetTrigger>
          <SheetContent side="bottom" className="sheet-md-modal p-0">
            <SheetHeader className="px-5 pt-5">
              <SheetTitle>Nueva categoría</SheetTitle>
            </SheetHeader>
            <form onSubmit={create} className="space-y-4 px-5 pb-6 pt-3">
              <div className="grid grid-cols-2 gap-2 rounded-2xl bg-muted p-1">
                <button
                  type="button"
                  onClick={() => setKind("expense")}
                  className={`h-10 rounded-xl text-sm font-medium transition ${
                    kind === "expense" ? "bg-background shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  Gasto
                </button>
                <button
                  type="button"
                  onClick={() => setKind("income")}
                  className={`h-10 rounded-xl text-sm font-medium transition ${
                    kind === "income" ? "bg-background shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  Ingreso
                </button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cat-name">Nombre</Label>
                <Input
                  id="cat-name"
                  className="h-12"
                  placeholder="Ej: Almuerzo, Combustible…"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Ícono</Label>
                <div className="grid max-h-72 grid-cols-6 gap-1.5 overflow-y-auto rounded-xl border p-2">
                  {CATEGORY_ICONS.map((it) => {
                    const Ico = it.icon;
                    const selected = icon === it.id;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => setIcon(it.id)}
                        title={it.label}
                        className={`flex aspect-square items-center justify-center rounded-lg transition ${
                          selected
                            ? "bg-brand text-brand-foreground"
                            : "hover:bg-muted"
                        }`}
                      >
                        <Ico className="size-5" />
                      </button>
                    );
                  })}
                </div>
              </div>

              <Button
                className="w-full h-12 bg-brand-grad text-white hover:opacity-95"
                type="submit"
                disabled={busy || !name.trim()}
              >
                {busy ? "Guardando…" : "Crear"}
              </Button>
            </form>
          </SheetContent>
        </Sheet>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!loading && categories.length === 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-16 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
              <Plus className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Todavía no creaste categorías</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Empezá agregando una para clasificar tus gastos e ingresos.
            </p>
          </CardContent>
        </Card>
      )}

      {categories.length > 0 && (
        <Tabs defaultValue="expense">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="expense">Gastos</TabsTrigger>
            <TabsTrigger value="income">Ingresos</TabsTrigger>
          </TabsList>
          {(["expense", "income"] as const).map((k) => (
            <TabsContent key={k} value={k} className="grid gap-2 pt-2 md:grid-cols-2">
              {categories
                .filter((c) => c.kind === k)
                .map((c) => (
                  <Card key={c.id} className="rounded-2xl">
                    <CardContent className="flex items-center gap-3 py-3">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground">
                        <CategoryIcon name={c.icon} className="size-5" />
                      </div>
                      <div className="flex-1 text-sm font-medium">{c.name}</div>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(c.id)}
                        aria-label="Eliminar"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
