"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategorySelect } from "@/components/category-select";
import { useAuth } from "@/hooks/use-auth";
import { useCategories, usePeople } from "@/hooks/use-data";
import { apiPost, errorText } from "@/lib/api";
import { firstName, linkScore, linkablePeople, type LinkablePerson, type Vaquita } from "@/lib/domain/vaquitas";
import { PersonSearch, selectedFromPick, type PersonPick, type SelectedPerson } from "./person-search";
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
  const [toAdd, setToAdd] = useState<SelectedPerson[]>([]);
  // Integrante "sin la app" que se está por vincular con su cuenta.
  const [linkingId, setLinkingId] = useState<string | null>(null);

  const expenseCats = categories.filter((c) => c.kind === "expense");
  const myCategory = user ? (v.categoryByUid?.[user.uid] ?? null) : null;
  const inVaquita = useMemo(() => new Set(v.members.map((m) => m.uid).filter(Boolean)), [v.members]);
  const addable = people.filter(
    (p) => !(p.ref.startsWith("u:") && inVaquita.has(p.ref.slice(2))) && !toAdd.some((x) => x.key === p.ref),
  );
  const linkable = linkablePeople(v, people);
  const offline = v.members.filter((m) => !m.uid);

  // Vincular a un integrante "sin la app": con un contacto, ya; por WhatsApp/email, cuando acepte o se sume.
  const link = async (memberId: string, memberName: string, pick: PersonPick) => {
    if (pick.type === "name") return false;
    const who = pick.type === "person" ? pick.person.name : pick.name || pick.q;
    const email = pick.type === "person" ? pick.person.email : null;
    if (
      pick.type === "person" &&
      !confirm(`¿Vincular a «${memberName}» (sin la app) con ${who}${email ? ` (${email})` : ""}? Va a ver la vaquita y su parte va a sus gastos.`)
    )
      return false;
    setBusy(`link-${memberId}`);
    try {
      const r = await apiPost<{ status: "linked" | "requested" | "invited"; name: string }>("/api/vaquitas/members/link", {
        id: v.id,
        memberId,
        ...(pick.type === "person" ? { ref: pick.person.ref } : { q: pick.q }),
      });
      toast.success(
        r.status === "linked"
          ? `Listo: ${firstName(r.name)} ya ve la vaquita`
          : r.status === "requested"
            ? `Le mandamos la solicitud a ${firstName(r.name)}: cuando acepte, queda vinculado`
            : `Invitamos a ${firstName(memberName)}: cuando se sume a La Libreta y acepte, queda vinculado`,
      );
      setLinkingId(null);
      return true;
    } catch (err) {
      toast.error(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

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

  // Al elegir a alguien de la app que se parece a un integrante "sin la app": ¿es el mismo? Mejor vincularlo que tenerlo dos veces.
  const pickToAdd = async (pick: PersonPick) => {
    if (pick.type !== "name") {
      const asPerson: LinkablePerson | null =
        pick.type === "person" ? pick.person : pick.found ? { ref: pick.q, name: pick.name, isApp: true } : null;
      const same = asPerson?.isApp ? offline.find((m) => linkScore(m, asPerson) > 0) : undefined;
      if (same && confirm(`¿${asPerson!.name} es el mismo que «${same.name}» (sin la app) de la vaquita? Si es, lo vinculo y queda una sola vez.`)) {
        await link(same.id, same.name, pick);
        return;
      }
    }
    const sel = selectedFromPick(pick);
    setToAdd((prev) => (prev.some((x) => x.key === sel.key) ? prev : [...prev, sel]));
  };

  const addPeople = async () => {
    if (!toAdd.length) return toast.error("Elegí a quién sumar");
    if (await run("add", "/api/vaquitas/members/add", { id: v.id, members: toAdd.map((x) => x.input) }, "Listo, ya están")) {
      setToAdd([]);
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
            <div key={m.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {m.name}
                    {m.uid === user?.uid && " (vos)"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {m.uid
                      ? "Usa la app"
                      : m.pendingLink === "request"
                        ? "Sin la app · le mandaste la solicitud: se vincula cuando acepte"
                        : m.pendingLink === "invite"
                          ? "Sin la app · invitado: se vincula cuando se sume"
                          : "Sin la app"}
                    {m.familyId && ` · ${v.families.find((f) => f.id === m.familyId)?.name ?? ""}`}
                  </div>
                </div>
                {!m.uid && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-brand"
                    onClick={() => setLinkingId((x) => (x === m.id ? null : m.id))}
                    aria-label={`Vincular a ${m.name} con su cuenta`}
                  >
                    <Link2 className="mr-1 size-4" /> {linkingId === m.id ? "Cerrar" : "Vincular"}
                  </Button>
                )}
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
              {linkingId === m.id && (
                <div className="mt-2 space-y-1.5 rounded-xl bg-muted/40 p-2.5">
                  <div className="text-xs text-muted-foreground">¿Quién es {firstName(m.name)} en La Libreta?</div>
                  <PersonSearch
                    people={linkable}
                    rank={(p) => linkScore(m, p)}
                    busy={busy === `link-${m.id}`}
                    placeholder="Contacto, WhatsApp o email"
                    foundHint="Le mandamos la solicitud y, cuando acepte, queda vinculado"
                    onPick={(pick) => link(m.id, m.name, pick)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="space-y-2 rounded-xl bg-muted/40 p-3">
          <div className="text-xs font-medium text-muted-foreground">Sumar gente</div>
          {toAdd.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {toAdd.map((x) => (
                <Chip key={x.key} active onClick={() => setToAdd((prev) => prev.filter((y) => y.key !== x.key))}>
                  {x.label}
                  {x.note && <span className="ml-1 text-[10px] opacity-70">{x.note}</span>}
                  <X className="ml-0.5 inline size-3" />
                </Chip>
              ))}
            </div>
          )}
          <PersonSearch people={addable} onPick={pickToAdd} allowName busy={busy === "add"} foundHint="Le mandamos la solicitud" />
          {toAdd.length > 0 && (
            <Button variant="outline" className="h-10 w-full" onClick={addPeople} disabled={busy === "add"}>
              <Plus className="mr-1 size-4" /> Sumar {toAdd.length === 1 ? "a 1 persona" : `a ${toAdd.length} personas`}
            </Button>
          )}
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
