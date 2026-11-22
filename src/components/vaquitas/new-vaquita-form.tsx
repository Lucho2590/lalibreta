"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { usePeople } from "@/hooks/use-data";
import { apiPost, errorText } from "@/lib/api";
import type { Currency } from "@/lib/domain/types";
import { currencyOptionLabel } from "@/lib/format";
import {
  Chip,
  CurrencyPicker,
  DatesPicker,
  FamiliesEditor,
  datesPayload,
  newFamilyId,
  todayLocal,
  type DatesValue,
  type FamilyDraft,
} from "./shared";

const ME = "me";

/** Crear una vaquita: nombre, moneda, quiénes y (opcional) familias. */
export function NewVaquitaForm({ onCreated }: { onCreated?: () => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const { data: people } = usePeople();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<Currency>("ARS");
  const [dates, setDates] = useState<DatesValue>(() => ({ mode: "day", start: todayLocal(), end: todayLocal() }));
  const [selected, setSelected] = useState<string[]>([]);
  const [extra, setExtra] = useState<Array<{ key: string; name: string }>>([]);
  const [extraName, setExtraName] = useState("");
  const [useFamilies, setUseFamilies] = useState(false);
  const [families, setFamilies] = useState<FamilyDraft[]>([
    { id: newFamilyId(), name: "Familia 1" },
    { id: newFamilyId(), name: "Familia 2" },
  ]);
  const [assignment, setAssignment] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);

  const toggle = (ref: string) =>
    setSelected((prev) => (prev.includes(ref) ? prev.filter((r) => r !== ref) : [...prev, ref]));
  const addExtra = () => {
    const n = extraName.trim();
    if (!n) return;
    setExtra((prev) => [...prev, { key: `x:${Date.now().toString(36)}${prev.length}`, name: n }]);
    setExtraName("");
  };

  const myName = user?.displayName?.split(" ")[0] || "Yo";
  const chosen = [
    { key: ME, name: `${myName} (vos)` },
    ...people.filter((p) => selected.includes(p.ref)).map((p) => ({ key: p.ref, name: p.name })),
    ...extra,
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast.error("Ponele un nombre");
    if (chosen.length < 2) return toast.error("Sumá al menos a otra persona");
    const fam = (key: string) => (useFamilies ? (assignment[key] ?? null) : null);
    if (dates.mode === "range" && dates.end < dates.start) return toast.error("La fecha de fin es anterior a la de inicio");
    setBusy(true);
    try {
      const r = await apiPost<{ id: string }>("/api/vaquitas", {
        name: name.trim(),
        currency,
        ...datesPayload(dates),
        families: useFamilies ? families.filter((f) => f.name.trim()) : [],
        myFamilyId: fam(ME),
        members: [
          ...selected.map((ref) => ({ ref, familyId: fam(ref) })),
          ...extra.map((x) => ({ name: x.name, familyId: fam(x.key) })),
        ],
      });
      toast.success("Vaquita creada");
      onCreated?.();
      router.push(`/vaquitas/${r.id}`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="vq-name">Nombre</Label>
        <Input
          id="vq-name"
          className="h-12"
          placeholder="Cena del viernes, Viaje a Brasil…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>

      <div className="space-y-1">
        <Label>¿Cuándo?</Label>
        <DatesPicker value={dates} onChange={setDates} />
      </div>

      <div className="space-y-1">
        <Label>Moneda de la vaquita</Label>
        <div>
          <CurrencyPicker value={currency} onChange={setCurrency} />
        </div>
        <p className="text-xs text-muted-foreground">
          {currencyOptionLabel(currency)}. Los saldos se muestran en esta moneda; si cargan un gasto en otra, se pasa con
          la cotización del día.
        </p>
      </div>

      <div className="space-y-2">
        <Label>¿Quiénes participan?</Label>
        <div className="flex flex-wrap gap-1.5">
          <Chip active onClick={() => {}} disabled>
            {myName} (vos)
          </Chip>
          {people.map((p) => (
            <Chip key={p.ref} active={selected.includes(p.ref)} onClick={() => toggle(p.ref)}>
              {p.name}
              {!p.isApp && <span className="ml-1 text-[10px] opacity-70">sin app</span>}
            </Chip>
          ))}
          {extra.map((x) => (
            <Chip key={x.key} active onClick={() => setExtra((prev) => prev.filter((y) => y.key !== x.key))}>
              {x.name} <X className="ml-0.5 inline size-3" />
            </Chip>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            className="h-10"
            placeholder="Alguien sin la app (nombre)"
            value={extraName}
            onChange={(e) => setExtraName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addExtra();
              }
            }}
          />
          <Button type="button" variant="outline" className="h-10" onClick={addExtra}>
            <Plus className="size-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          La gente de la app la ve y la edita. Para sumar a alguien de la app, primero conectate en{" "}
          <Link href="/contactos" className="underline">
            Contactos
          </Link>
          .
        </p>
      </div>

      <div className="space-y-3 rounded-2xl border p-3">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium">Van en familias</span>
            <span className="block text-xs text-muted-foreground">
              Cada familia es una sola parte: el saldo es entre familias, no entre personas.
            </span>
          </span>
          <Switch checked={useFamilies} onCheckedChange={setUseFamilies} />
        </label>
        {useFamilies && (
          <FamiliesEditor
            people={chosen}
            families={families}
            assignment={assignment}
            onChange={(f, a) => {
              setFamilies(f);
              setAssignment(a);
            }}
          />
        )}
      </div>

      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={busy}>
        {busy ? "Creando…" : "Crear vaquita"}
      </Button>
    </form>
  );
}
