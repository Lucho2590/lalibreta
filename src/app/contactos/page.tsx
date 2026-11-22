"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Pencil, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useConnections, useContacts } from "@/hooks/use-data";
import { ContactForm } from "@/components/contacts/contact-form";
import { AddPersonCard, type OfflineDraft } from "@/components/contacts/add-person-card";
import { EditContactSheet, type EditContactTarget } from "@/components/contacts/edit-contact-sheet";
import { apiPost, errorText } from "@/lib/api";
import { deleteContact } from "@/lib/domain/contacts";
import { contactDisplayName, formatPayAlias } from "@/lib/domain/contact-info";
import { otherUid, profileName, type Connection } from "@/lib/domain/people";
import type { Contact } from "@/lib/domain/types";

const initial = (s: string | null | undefined) => (s?.trim()?.[0] ?? "?").toUpperCase();

/** "Orne, mi señora · alias orne.mp": lo que cargué en su ficha. */
const infoLine = (c: Contact | undefined): string | null => {
  if (!c) return null;
  const parts = [
    c.nicknames?.length ? c.nicknames.join(", ") : null,
    c.payAliases?.length
      ? `${c.payAliases.length > 1 ? "alias: " : "alias "}${c.payAliases.map(formatPayAlias).join(", ")}`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
};

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="icon" variant="ghost" className="text-muted-foreground" aria-label="Editar ficha" onClick={onClick}>
      <Pencil className="size-4" />
    </Button>
  );
}

function PersonRow({
  name,
  sub,
  photo,
  href,
  children,
}: {
  name: string;
  sub?: string | null;
  photo?: string | null;
  href?: string;
  children?: React.ReactNode;
}) {
  return (
  <div className="flex items-center gap-3 py-2.5">
    <Avatar className="size-10">
      {photo && <AvatarImage src={photo} alt="" />}
      <AvatarFallback>{initial(name)}</AvatarFallback>
    </Avatar>
    <div className="min-w-0 flex-1">
      {href ? (
        <Link href={href} className="block truncate text-sm font-semibold hover:underline">
          {name}
        </Link>
      ) : (
        <div className="truncate text-sm font-semibold">{name}</div>
      )}
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
    {children}
  </div>
);
}

export default function ContactsPage() {
  const { user } = useAuth();
  const { data: connections, loading: loadingConn } = useConnections();
  const { data: contacts, loading: loadingContacts } = useContacts();
  const [offlineDraft, setOfflineDraft] = useState<OfflineDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EditContactTarget | null>(null);

  const me = user?.uid ?? "";
  const incoming = connections.filter((c) => c.status === "pending" && c.addresseeUid === me);
  const outgoing = connections.filter((c) => c.status === "pending" && c.requesterUid === me);
  const connected = connections
    .filter((c) => c.status === "accepted")
    .sort((a, b) => connName(a).localeCompare(connName(b), "es"));
  const offline = contacts.filter((c) => !c.linkedUid && c.kind !== "app");
  const contactByUid = new Map(contacts.filter((c) => c.linkedUid).map((c) => [c.linkedUid as string, c]));
  const connName = (c: Connection) => {
    const uid = otherUid(c, me);
    return contactByUid.get(uid)?.customName?.trim() || profileName(c.profiles[uid]);
  };

  const act = async (c: Connection, path: string, body: object, ok: string, ask?: string) => {
    if (ask && !confirm(ask)) return;
    setBusyId(c.id);
    try {
      await apiPost(path, { id: c.id, ...body });
      toast.success(ok);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  const removeOffline = async (c: Contact) => {
    if (!user || !confirm(`¿Borrar a ${contactDisplayName(c)}? Lo que ya anotaste con esa persona queda en el historial.`)) return;
    try {
      await deleteContact(user.uid, c.id);
      toast.success("Contacto borrado");
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Contactos</h1>
        <p className="text-sm text-muted-foreground">
          La gente con la que compartís gastos. Cargales apodos y alias: el agente los encuentra por cómo los
          nombrás y te pasa el alias cuando querés transferirles.
        </p>
      </div>

      {incoming.length > 0 && (
        <Card className="rounded-3xl ring-2 ring-brand/30">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <UserPlus className="size-4" /> Quieren conectarse con vos
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {incoming.map((c) => {
              const p = c.profiles[c.requesterUid];
              return (
                <PersonRow key={c.id} name={profileName(p)} sub={p?.email} photo={p?.photoURL}>
                  <Button
                    size="sm"
                    disabled={busyId === c.id}
                    onClick={() => act(c, "/api/connections/respond", { accept: true }, `Conectado con ${profileName(p)}`)}
                  >
                    <Check className="mr-1 size-4" /> Aceptar
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busyId === c.id}
                    aria-label="Rechazar"
                    onClick={() => act(c, "/api/connections/respond", { accept: false }, "Solicitud rechazada")}
                  >
                    <X className="size-4" />
                  </Button>
                </PersonRow>
              );
            })}
          </CardContent>
        </Card>
      )}

      <AddPersonCard
        onAddOffline={(draft) => {
          setOfflineDraft(draft);
          setOpen(true);
        }}
      />

      <Card className="rounded-3xl">
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
            <Users className="size-4" /> Conectados
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {loadingConn && <p className="py-2 text-xs text-muted-foreground">Cargando…</p>}
          {!loadingConn && connected.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">Todavía no te conectaste con nadie.</p>
          )}
          {connected.map((c) => {
            const uid = otherUid(c, me);
            const p = c.profiles[uid];
            const mine = contactByUid.get(uid);
            return (
              <PersonRow
                key={c.id}
                name={connName(c)}
                sub={infoLine(mine) ?? p?.email}
                photo={p?.photoURL}
                href={`/compartidas/persona/u:${uid}`}
              >
                <EditButton
                  onClick={() =>
                    setEditing(
                      mine
                        ? { contactId: mine.id }
                        : {
                            appUser: {
                              uid,
                              email: p?.email ?? "",
                              displayName: p?.displayName ?? null,
                              photoURL: p?.photoURL ?? null,
                            },
                          },
                    )
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={busyId === c.id}
                  onClick={() =>
                    act(
                      c,
                      "/api/connections/remove",
                      {},
                      "Desconectados",
                      `¿Desconectarte de ${profileName(p)}? Lo pendiente entre ustedes se cancela; lo aceptado queda en el historial.`,
                    )
                  }
                >
                  Desconectar
                </Button>
              </PersonRow>
            );
          })}
          {outgoing.map((c) => {
            const p = c.profiles[c.addresseeUid];
            return (
              <PersonRow key={c.id} name={profileName(p)} sub="Solicitud enviada · esperando respuesta" photo={p?.photoURL}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={busyId === c.id}
                  onClick={() => act(c, "/api/connections/remove", {}, "Solicitud cancelada")}
                >
                  Cancelar
                </Button>
              </PersonRow>
            );
          })}
        </CardContent>
      </Card>

      <Card className="rounded-3xl">
        <CardHeader className="flex flex-row items-start justify-between gap-2 pb-1">
          <div>
            <CardTitle className="text-sm font-semibold">Sin la app</CardTitle>
            <p className="text-xs text-muted-foreground">
              Gente a la que le pagás cosas o le prestás plata: la app te recuerda cobrarle.
            </p>
          </div>
          <Sheet
            open={open}
            onOpenChange={(v) => {
              setOpen(v);
              if (!v) setOfflineDraft(null);
            }}
          >
            <SheetTrigger render={<Button size="sm" variant="outline" />}>
              <Plus className="mr-1 size-4" /> Agregar
            </SheetTrigger>
            <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
              <SheetHeader className="px-5 pt-5">
                <SheetTitle>Persona sin la app</SheetTitle>
              </SheetHeader>
              <div className="px-5 pb-6 pt-3">
                <ContactForm
                  key={offlineDraft ? `${offlineDraft.phone ?? ""}|${offlineDraft.email ?? ""}` : "new"}
                  initial={offlineDraft ?? undefined}
                  onSaved={() => {
                    setOpen(false);
                    setOfflineDraft(null);
                  }}
                />
              </div>
            </SheetContent>
          </Sheet>
        </CardHeader>
        <CardContent className="divide-y">
          {loadingContacts && <p className="py-2 text-xs text-muted-foreground">Cargando…</p>}
          {!loadingContacts && offline.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">No agregaste a nadie todavía.</p>
          )}
          {offline.map((c) => (
            <PersonRow
              key={c.id}
              name={contactDisplayName(c)}
              sub={infoLine(c) ?? ([c.phone, c.email].filter(Boolean).join(" · ") || null)}
              href={`/compartidas/persona/c:${c.id}`}
            >
              <EditButton onClick={() => setEditing({ contactId: c.id })} />
              <Button size="icon" variant="ghost" aria-label="Borrar" onClick={() => removeOffline(c)}>
                <Trash2 className="size-4" />
              </Button>
            </PersonRow>
          ))}
        </CardContent>
      </Card>

      <EditContactSheet target={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
