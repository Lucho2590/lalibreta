"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/api";
import {
  createActivity,
  ymdAR,
  type Activity,
  type Invitee,
} from "@/lib/domain/activities";
import { userCurrencies, type Currency } from "@/lib/domain/types";
import { useAccounts } from "@/hooks/use-data";
import { currencyOptionLabel, parseAmount } from "@/lib/format";
import { ParticipantsPicker } from "./participants-picker";

/** Nueva actividad o edición de una mía. */
export function ActivityForm({
  activity,
  defaultDate,
  onDone,
}: {
  activity?: Activity;
  defaultDate?: string;
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState(activity?.title ?? "");
  const [date, setDate] = useState(activity?.date ?? defaultDate ?? ymdAR());
  const [time, setTime] = useState(activity?.time ?? "");
  const [location, setLocation] = useState(activity?.location ?? "");
  const [notes, setNotes] = useState(activity?.notes ?? "");
  const [amount, setAmount] = useState(activity?.estimatedAmount ? String(activity.estimatedAmount).replace(".", ",") : "");
  const [currency, setCurrency] = useState<Currency>(activity?.currency ?? "ARS");
  const { data: accounts } = useAccounts();
  const currencyChoices = [...new Set([...userCurrencies(accounts), currency])];
  const [people, setPeople] = useState<Invitee[]>(
    activity?.participants
      .filter((p) => p.status !== "owner")
      .map((p) => ({ uid: p.uid, email: p.email, displayName: p.displayName, photoURL: p.photoURL })) ?? [],
  );
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!title.trim()) return toast.error("Poné qué es");
    if (!date) return toast.error("Elegí el día");
    const estimated = amount.trim() ? parseAmount(amount) : null;
    if (estimated != null && !(estimated > 0)) return toast.error("El monto no es válido (ej. 25.000)");

    setSaving(true);
    try {
      const owner = {
        uid: user.uid,
        email: user.email ?? "",
        displayName: user.displayName ?? null,
        photoURL: user.photoURL ?? null,
      };
      const input = { title, date, time: time || null, location, notes, estimatedAmount: estimated, currency };
      if (activity) {
        // En el server: compara antes/después y les avisa a los invitados.
        const r = await apiFetch("/api/activities/update", {
          method: "POST",
          body: JSON.stringify({ activityId: activity.id, input, invitees: people }),
        });
        const data = (await r.json().catch(() => null)) as
          | { error?: string; invited?: number; notifiedChange?: number; notifiedRemoved?: number }
          | null;
        if (!r.ok) throw new Error(data?.error ?? "No se pudo guardar");
        const told = (data?.notifiedChange ?? 0) + (data?.notifiedRemoved ?? 0);
        toast.success(
          told > 0 ? `Actividad actualizada. Les avisamos a ${told} ${told === 1 ? "persona" : "personas"}` : "Actividad actualizada",
        );
        if (data?.invited) toast.success(data.invited === 1 ? "Invitación enviada" : `${data.invited} invitaciones enviadas`);
        onDone?.();
        return;
      }
      const { id, added } = await createActivity(owner, input, people);
      toast.success("Agendada");
      if (added.length > 0) {
        apiFetch("/api/activities/invite", { method: "POST", body: JSON.stringify({ activityId: id, emails: added }) })
          .then((r) => {
            if (r.ok) toast.success(added.length === 1 ? "Invitación enviada" : `${added.length} invitaciones enviadas`);
            else toast.error("No se pudieron mandar las invitaciones");
          })
          .catch(() => toast.error("No se pudieron mandar las invitaciones"));
      }
      onDone?.();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error && err.message ? err.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  };

  const statusOf = (email: string) =>
    activity?.participants.find((p) => p.email.toLowerCase() === email.toLowerCase())?.status;

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="act-title">¿Qué es?</Label>
        <Input
          id="act-title"
          className="h-12 text-base"
          placeholder="Cena con amigos, turno médico, cumple de Juan…"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="act-date">Día</Label>
          <Input id="act-date" type="date" className="h-12" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="act-time">Hora</Label>
          <Input
            id="act-time"
            type="time"
            className="h-12"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          {!time && <p className="text-[11px] text-muted-foreground">Vacío = todo el día</p>}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="act-location">Dónde</Label>
        <Input
          id="act-location"
          className="h-12"
          placeholder="Opcional"
          value={location}
          maxLength={120}
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="act-amount">¿Lleva un gasto?</Label>
        <Input
          id="act-amount"
          inputMode="decimal"
          autoComplete="off"
          className="h-12"
          placeholder="Cuánto calculás (opcional)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="mt-1.5 inline-flex flex-wrap rounded-lg bg-muted p-0.5">
          {currencyChoices.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              className={`h-8 rounded-md px-3 text-xs font-medium transition ${
                currency === c ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {currencyOptionLabel(c)}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Cuando pase, lo cargás con un toque desde la agenda (y si querés, lo dividís).
        </p>
      </div>

      <div className="space-y-1">
        <Label>¿Con quién?</Label>
        <ParticipantsPicker value={people} onChange={setPeople} statusOf={statusOf} excludeEmail={user?.email} />
        <p className="text-[11px] text-muted-foreground">
          Les llega la invitación y, si aceptan, la ven en su agenda.
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="act-notes">Notas</Label>
        <textarea
          id="act-notes"
          rows={2}
          maxLength={500}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          placeholder="Opcional"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <Button type="submit" className="h-12 w-full bg-brand-grad text-white hover:opacity-95" disabled={saving}>
        {saving ? "Guardando…" : activity ? "Guardar cambios" : "Agendar"}
      </Button>
    </form>
  );
}
