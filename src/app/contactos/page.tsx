"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Plus,
  RefreshCcw,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useContacts } from "@/hooks/use-data";
import { ContactForm } from "@/components/contacts/contact-form";
import { apiFetch } from "@/lib/api";
import { deleteContact, updateContactLink } from "@/lib/domain/contacts";
import type { Contact } from "@/lib/domain/types";

export default function ContactsPage() {
  const { user } = useAuth();
  const { data: contacts, loading } = useContacts();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Re-chequea en background los contactos no vinculados, una vez por carga,
  // por si se registraron después de haberlos agregado.
  useEffect(() => {
    if (!user || contacts.length === 0) return;
    const unlinked = contacts.filter((c) => !c.linkedUid);
    if (unlinked.length === 0 || unlinked.length > 50) return;
    let cancelled = false;
    (async () => {
      for (const c of unlinked) {
        if (cancelled) break;
        try {
          const r = await apiFetch(
            `/api/users/lookup?email=${encodeURIComponent(c.email)}`,
          );
          if (!r.ok) continue;
          const data = (await r.json()) as {
            uid: string;
            displayName: string | null;
            photoURL: string | null;
          };
          await updateContactLink(user.uid, c.id, {
            linkedUid: data.uid,
            displayName: c.displayName ?? data.displayName,
            photoURL: c.photoURL ?? data.photoURL,
          });
        } catch (err) {
          console.warn("[contacts] re-link falló", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Solo cuando cambia la cantidad de contactos no vinculados.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, contacts.length]);

  const remove = async (c: Contact) => {
    if (!user) return;
    if (!confirm(`¿Eliminar ${c.displayName ?? c.email} de la agenda?`)) return;
    try {
      await deleteContact(user.uid, c.id);
      toast.success("Contacto eliminado");
    } catch (err) {
      toast.error("No se pudo eliminar");
      console.error(err);
    }
  };

  const refreshAll = async () => {
    if (!user || refreshing) return;
    setRefreshing(true);
    try {
      let updated = 0;
      for (const c of contacts) {
        const r = await apiFetch(
          `/api/users/lookup?email=${encodeURIComponent(c.email)}`,
        );
        if (r.ok) {
          const data = (await r.json()) as {
            uid: string;
            displayName: string | null;
            photoURL: string | null;
          };
          if (c.linkedUid !== data.uid) updated += 1;
          await updateContactLink(user.uid, c.id, {
            linkedUid: data.uid,
            displayName: c.displayName ?? data.displayName,
            photoURL: c.photoURL ?? data.photoURL,
          });
        } else if (c.linkedUid) {
          // Si estaba linkeado pero ya no aparece (raro), lo desvinculamos.
          updated += 1;
          await updateContactLink(user.uid, c.id, { linkedUid: null });
        }
      }
      toast.success(
        updated > 0 ? `Verificado · ${updated} actualizados` : "Todo al día",
      );
    } catch (err) {
      toast.error("Falló la verificación");
      console.error(err);
    } finally {
      setRefreshing(false);
    }
  };

  const initialFor = (c: Contact) =>
    (c.displayName?.[0] ?? c.email[0] ?? "?").toUpperCase();

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Contactos</h1>
          <p className="text-sm text-muted-foreground">
            Gente con quien compartís gastos
          </p>
        </div>
        <div className="flex gap-2">
          {contacts.length > 0 && (
            <Button
              variant="outline"
              size="icon"
              onClick={refreshAll}
              disabled={refreshing}
              aria-label="Verificar registrados"
              title="Verificar registrados"
            >
              <RefreshCcw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          )}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={<Button className="bg-brand-grad text-white hover:opacity-95" />}
            >
              <Plus className="mr-1 size-4" /> Nuevo contacto
            </SheetTrigger>
            <SheetContent side="bottom" className="sheet-md-modal p-0">
              <SheetHeader className="px-5 pt-5">
                <SheetTitle>Nuevo contacto</SheetTitle>
              </SheetHeader>
              <div className="px-5 pb-6 pt-3">
                <ContactForm onCreated={() => setOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!loading && contacts.length === 0 && (
        <Card className="rounded-3xl">
          <CardContent className="py-16 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
              <Users className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Tu agenda está vacía</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Agregá personas por email — si están en la app las vinculamos automáticamente.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-2 md:grid-cols-2">
        {contacts.map((c) => {
          const linked = !!c.linkedUid;
          return (
            <Card key={c.id} className="rounded-2xl">
              <CardContent className="flex items-center gap-3 py-3.5">
                <Avatar className="size-10">
                  {c.photoURL && <AvatarImage src={c.photoURL} alt="" />}
                  <AvatarFallback>{initialFor(c)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {c.displayName || c.email}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{c.email}</span>
                  </div>
                </div>
                {linked ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
                    <CheckCircle2 className="size-3" /> En la app
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                    <Circle className="size-3" /> Sin registrar
                  </span>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => remove(c)}
                  aria-label="Eliminar"
                >
                  <Trash2 className="size-4" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
