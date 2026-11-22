"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategorySelect } from "@/components/category-select";
import { useAuth } from "@/hooks/use-auth";
import { useCategories, usePeople } from "@/hooks/use-data";
import { apiPost, errorText } from "@/lib/api";
import { firstName, type Vaquita } from "@/lib/domain/vaquitas";
import { Chip, DatesPicker, FamiliesEditor, datesFromVaquita, datesPayload, type DatesValue, type FamilyDraft } from "./shared";

/** Ajustes de una vaquita: nombre, mi categoría, gente, familias, cerrar y borrar. */
export function VaquitaSettings({ vaquita: v, onClose }: { vaquita: Vaquita; onClose?: () => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const { data: categories } = useCategories();
  const { data: people } = usePeople();
  const [name, setName] = useState(v.name);
  const [dates, setDates] = useState<DatesValue>(() => datesFromVaquita(v));
  const [datesDirty, setDatesDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [families, setFamilies] = useState<FamilyDraft[]>(v.families.map((f) => ({ ...f })));
  const [assignment, setAssignment] = useState<Record<string, string | null>>(
    Object.fromEntries(v.members.map((m) => [m.id, m.familyId])),
  );
  const [famDirty, setFamDirty] = useState(false);
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [extraName, setExtraName] = useState("");

  const expenseCats = categories.filter((c) => c.kind === "expense");
  const myCategory = user ? (v.categoryByUid?.[user.uid] ?? null) : null;
  const inVaquita = useMemo(() => new Set(v.members.map((m) => m.uid).filter(Boolean)), [v.members]);
  const addable = people.filter((p) => !(p.ref.startsWith("u:") && inVaquita.has(p.ref.slice(2))));

  const run = async (key: string, path: string, body: unknown, ok: string) => {
    setBusy(key);
    try {
      await apiPost(path, body);
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addPeople = async () => {
    const members = [
      ...toAdd.map((ref) => ({ ref })),
      ...(extraName.trim() ? [{ name: extraName.trim() }] : []),
    ];
    if (!members.length) return toast.error("Elegí a quién sumar");
    if (await run("add", "/api/vaquitas/members/add", { id: v.id, members }, "Listo, ya están")) {
      setToAdd([]);
      setExtraName("");
    }
  };

  const removeMember = async (memberId: string, memberName: string) => {
    const isMe = v.members.find((m) => m.id === memberId)?.uid === user?.uid;
    if (!confirm(isMe ? "¿Salir de esta vaquita?" : `¿Sacar a ${memberName} de la vaquita?`)) return;
    if (await run(`rm-${memberId}`, "/api/vaquitas/members/remove", { id: v.id, memberId }, isMe ? "Saliste" : "Listo")) {
      if (isMe) router.push("/vaquitas");
    }
  };

  const saveFamilies = async () => {
    if (
      await run(
        "fam",
        "/api/vaquitas/families",
        { id: v.id, families: families.filter((f) => f.name.trim()), assignment },
        "Familias guardadas",
      )
    )
      setFamDirty(false);
  };

  const remove = async () => {
    if (!confirm(`¿Borrar «${v.name}»? Se borran todos sus gastos y pagos, también de las cuentas de todos.`)) return;
    if (await run("del", "/api/vaquitas/delete", { id: v.id }, "Vaquita borrada")) router.push("/vaquitas");
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label htmlFor="vqs-name">Nombre</Label>
        <div className="flex gap-2">
          <Input id="vqs-name" className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            variant="outline"
            className="h-11"
            disabled={busy === "name" || name.trim() === v.name || !name.trim()}
            onClick={() => run("name", "/api/vaquitas/update", { id: v.id, name }, "Nombre cambiado")}
          >
            Guardar
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <Label>¿Cuándo?</Label>
        <DatesPicker
          value={dates}
          onChange={(d) => {
            setDates(d);
            setDatesDirty(true);
          }}
        />
        {datesDirty && (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy === "dates"}
            onClick={async () => {
              if (dates.mode === "range" && dates.end < dates.start) return toast.error("La fecha de fin es anterior a la de inicio");
              if (await run("dates", "/api/vaquitas/update", { id: v.id, dates: datesPayload(dates) }, "Fechas guardadas")) setDatesDirty(false);
            }}
          >
            Guardar fechas
          </Button>
        )}
      </section>

      <section className="space-y-2">
        <Label>Tu categoría para esta vaquita</Label>
        <CategorySelect
          value={myCategory}
          onChange={(categoryId) => run("cat", "/api/vaquitas/update", { id: v.id, categoryId }, "Categoría cambiada")}
          groups={[{ categories: expenseCats }]}
          placeholder="Elegí una categoría"
        />
        <p className="text-xs text-muted-foreground">Así aparecen en tus gastos (cada uno elige la suya).</p>
      </section>

      <section className="space-y-2">
        <Label>Integrantes</Label>
        <div className="divide-y rounded-xl border">
          {v.members.map((m) => (
            <div key={m.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {m.name}
                  {m.uid === user?.uid && " (vos)"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {m.uid ? "Usa la app" : "Sin la app"}
                  {m.familyId && ` · ${v.families.find((f) => f.id === m.familyId)?.name ?? ""}`}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground"
                disabled={busy === `rm-${m.id}`}
                onClick={() => removeMember(m.id, firstName(m.name))}
                aria-label={m.uid === user?.uid ? "Salir" : `Sacar a ${m.name}`}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="space-y-2 rounded-xl bg-muted/40 p-3">
          <div className="text-xs font-medium text-muted-foreground">Sumar gente</div>
          {addable.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {addable.map((p) => (
                <Chip
                  key={p.ref}
                  active={toAdd.includes(p.ref)}
                  onClick={() => setToAdd((prev) => (prev.includes(p.ref) ? prev.filter((r) => r !== p.ref) : [...prev, p.ref]))}
                >
                  {p.name}
                </Chip>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              className="h-10 bg-background"
              placeholder="Alguien sin la app (nombre)"
              value={extraName}
              onChange={(e) => setExtraName(e.target.value)}
            />
            <Button variant="outline" className="h-10" onClick={addPeople} disabled={busy === "add"}>
              <Plus className="mr-1 size-4" /> Sumar
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <Label>Familias</Label>
        <p className="text-xs text-muted-foreground">
          Cada familia es una sola parte: el saldo es entre familias. Al cambiarlas se recalcula todo.
        </p>
        <FamiliesEditor
          people={v.members.map((m) => ({ key: m.id, name: m.uid === user?.uid ? `${m.name} (vos)` : m.name }))}
          families={families}
          assignment={assignment}
          onChange={(f, a) => {
            setFamilies(f);
            setAssignment(a);
            setFamDirty(true);
          }}
        />
        {famDirty && (
          <Button className="w-full" onClick={saveFamilies} disabled={busy === "fam"}>
            {busy === "fam" ? "Guardando…" : "Guardar familias"}
          </Button>
        )}
      </section>

      <section className="space-y-2 border-t pt-4">
        {v.status === "open" ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy === "status"}
            onClick={async () => {
              if (await run("status", "/api/vaquitas/update", { id: v.id, status: "closed" }, "Vaquita cerrada")) onClose?.();
            }}
          >
            Cerrar vaquita (pasa al historial)
          </Button>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy === "status"}
            onClick={() => run("status", "/api/vaquitas/update", { id: v.id, status: "open" }, "Vaquita abierta de nuevo")}
          >
            Volver a abrir
          </Button>
        )}
        {v.createdByUid === user?.uid && (
          <Button variant="ghost" className="w-full text-destructive" onClick={remove} disabled={busy === "del"}>
            Borrar vaquita
          </Button>
        )}
      </section>
    </div>
  );
}
