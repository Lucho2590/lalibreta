"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/api";
import { dayLabel, type Activity, type Invitee } from "@/lib/domain/activities";
import { ParticipantsPicker } from "./participants-picker";

/**
 * Compartir una actividad mía: sumar (o sacar) gente sin pasar por todo el
 * formulario de edición. A los nuevos les llega la invitación y, si aceptan,
 * la ven en su agenda.
 */
export function ShareActivityForm({ activity, onDone }: { activity: Activity; onDone?: () => void }) {
  const { user } = useAuth();
  const [people, setPeople] = useState<Invitee[]>(
    activity.participants
      .filter((p) => p.status !== "owner")
      .map((p) => ({ uid: p.uid, email: p.email, displayName: p.displayName, photoURL: p.photoURL })),
  );
  const [saving, setSaving] = useState(false);

  const before = new Set(activity.participants.filter((p) => p.status !== "owner").map((p) => p.email.toLowerCase()));
  const now = new Set(people.map((p) => p.email.toLowerCase()));
  const dirty = before.size !== now.size || [...now].some((e) => !before.has(e));

  const statusOf = (email: string) =>
    activity.participants.find((p) => p.email.toLowerCase() === email.toLowerCase())?.status;

  const save = async () => {
    setSaving(true);
    try {
      // Mismo endpoint que "Editar": los datos de la actividad van igual, solo cambia con quién.
      const r = await apiFetch("/api/activities/update", {
        method: "POST",
        body: JSON.stringify({
          activityId: activity.id,
          input: {
            title: activity.title,
            date: activity.date,
            time: activity.time ?? null,
            location: activity.location ?? null,
            notes: activity.notes ?? null,
            estimatedAmount: activity.estimatedAmount ?? null,
            currency: activity.currency ?? null,
          },
          invitees: people,
        }),
      });
      const data = (await r.json().catch(() => null)) as
        | { error?: string; invited?: number; notifiedRemoved?: number }
        | null;
      if (!r.ok) throw new Error(data?.error ?? "No se pudo compartir");
      const invited = data?.invited ?? 0;
      const removed = data?.notifiedRemoved ?? 0;
      if (invited > 0) toast.success(invited === 1 ? "Invitación enviada" : `${invited} invitaciones enviadas`);
      else if (removed > 0) toast.success("Listo, le avisamos a quien sacaste");
      else toast.success("Listo");
      onDone?.();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error && err.message ? err.message : "No se pudo compartir");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{activity.title}</span> · {dayLabel(activity.date)}
        {activity.time ? ` · ${activity.time}` : ""}
      </p>
      <ParticipantsPicker value={people} onChange={setPeople} statusOf={statusOf} excludeEmail={user?.email} />
      <p className="text-[11px] text-muted-foreground">
        Les llega la invitación (en la app, por WhatsApp o por mail si no usan La Libreta) y, si aceptan, la ven en su
        agenda. Si después cambiás algo, les avisamos.
      </p>
      <Button
        type="button"
        className="h-12 w-full bg-brand-grad text-white hover:opacity-95"
        disabled={saving || !dirty}
        onClick={save}
      >
        {saving ? "Guardando…" : "Compartir"}
      </Button>
    </div>
  );
}
