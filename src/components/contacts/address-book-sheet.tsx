"use client";

import { useRef, useState } from "react";
import { BookUser, Check, FileUp, Loader2, Mail, MessageCircle, Send, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { apiPost, errorText } from "@/lib/api";
import { addOfflineContact } from "@/lib/domain/contacts";
import { cleanBookContacts, parseVCards, type BookContact } from "@/lib/domain/address-book";
import { formatPhone, inviteMessage, waMeLink } from "@/lib/domain/phone";
import type { LookupState } from "./use-contact-lookup";

interface BookMatch {
  name: string;
  phones: string[];
  emails: string[];
  user: { q: string; name: string; photoURL: string | null; state: LookupState } | null;
  offlineContactId: string | null;
}

/** Selector de contactos del navegador (Chrome en Android; en iPhone viene apagado). */
interface ContactsManager {
  select: (
    props: Array<"name" | "tel" | "email">,
    opts?: { multiple?: boolean },
  ) => Promise<Array<{ name?: string[]; tel?: string[]; email?: string[] }>>;
}
const contactsManager = (): ContactsManager | null => {
  if (typeof navigator === "undefined") return null;
  const c = (navigator as Navigator & { contacts?: ContactsManager }).contacts;
  return c && typeof c.select === "function" ? c : null;
};

const STATE_TEXT: Record<string, string> = {
  self: "Sos vos 🙂",
  connected: "Ya están conectados",
  outgoing: "Solicitud enviada",
  incoming: "Te mandó una solicitud: aceptala arriba",
};

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

/**
 * "Desde mis contactos": elige gente de la agenda del teléfono (o importa un
 * .vcf en iPhone) y muestra quiénes usan La Libreta (para mandarles la
 * solicitud) y quiénes no (para invitarlos o agendarlos sin app).
 */
export function AddressBookButton() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<BookMatch[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const lookup = async (contacts: BookContact[]) => {
    if (!contacts.length) {
      toast.error("Esos contactos no tienen teléfono ni email");
      return;
    }
    setOpen(true);
    setLoading(true);
    try {
      const r = await apiPost<{ results: BookMatch[] }>("/api/connections/lookup-book", { contacts });
      setResults(r.results);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  const start = async () => {
    const picker = contactsManager();
    if (!picker) {
      setResults(null);
      setOpen(true);
      return;
    }
    try {
      const picked = await picker.select(["name", "tel", "email"], { multiple: true });
      if (!picked.length) return;
      await lookup(cleanBookContacts(picked.map((p) => ({ name: p.name?.[0], phones: p.tel, emails: p.email }))));
    } catch (err) {
      console.warn("[contacts] picker", err);
      setResults(null);
      setOpen(true);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5_000_000) {
      toast.error("El archivo es muy pesado");
      return;
    }
    const contacts = parseVCards(await file.text());
    if (fileRef.current) fileRef.current.value = "";
    await lookup(contacts);
  };

  const patch = (i: number, p: Partial<BookMatch>) =>
    setResults((prev) => prev?.map((r, j) => (j === i ? { ...r, ...p } : r)) ?? prev);

  const connect = async (i: number) => {
    const r = results?.[i];
    if (!r?.user) return;
    setBusy(`c${i}`);
    try {
      const res = await apiPost<{ status: string; name: string }>("/api/connections/request", { q: r.user.q });
      patch(i, { user: { ...r.user, state: res.status === "accepted" ? "connected" : "outgoing" } });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const connectAll = async () => {
    const idx = (results ?? []).map((r, i) => (r.user?.state === "none" ? i : -1)).filter((i) => i >= 0);
    for (const i of idx) await connect(i);
    toast.success(idx.length > 1 ? `Les mandamos la solicitud a ${idx.length} personas` : "Solicitud enviada");
  };

  const mail = async (i: number) => {
    const r = results?.[i];
    if (!r?.emails[0]) return;
    setBusy(`m${i}`);
    try {
      await apiPost("/api/connections/invite", { email: r.emails[0], name: r.name });
      toast.success(`Le mandamos la invitación a ${r.name}`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async (i: number) => {
    const r = results?.[i];
    if (!r || !user) return;
    setBusy(`s${i}`);
    try {
      const id = await addOfflineContact(user.uid, {
        name: r.name,
        phone: r.phones[0] ? formatPhone(r.phones[0]) : null,
        email: r.emails[0] ?? null,
      });
      patch(i, { offlineContactId: id });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const users = (results ?? []).map((r, i) => ({ r, i })).filter((x) => x.r.user);
  const others = (results ?? []).map((r, i) => ({ r, i })).filter((x) => !x.r.user);
  const pendingInvites = users.filter((x) => x.r.user?.state === "none").length;
  const appUrl = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <>
      <Button type="button" variant="outline" className="h-11 w-full" onClick={start}>
        <BookUser className="mr-1.5 size-4" /> Buscar en mis contactos
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle>Desde mis contactos</SheetTitle>
          </SheetHeader>
          <div className="space-y-5 px-5 pb-6 pt-3">
            <input
              ref={fileRef}
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            {loading && (
              <p className="flex items-center gap-1.5 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Buscando quiénes usan La Libreta…
              </p>
            )}

            {!loading && !results && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  En el iPhone la app no puede abrir tu agenda directamente, pero hay dos formas fáciles:
                </p>
                <div className="space-y-1.5 rounded-2xl bg-muted/60 p-4">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <MessageCircle className="size-4" /> Por WhatsApp (la más fácil)
                  </div>
                  <p className="text-xs text-muted-foreground">
                    En el chat con tu agente tocá 📎 → <span className="font-medium">Contacto</span>, elegí uno o
                    varios y mandalos. Te dice quién usa La Libreta, le manda la solicitud y a los demás te ofrece
                    invitarlos.
                  </p>
                </div>
                <div className="space-y-2 rounded-2xl bg-muted/60 p-4">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <FileUp className="size-4" /> Con un archivo de contactos (.vcf)
                  </div>
                  <p className="text-xs text-muted-foreground">
                    En la app Contactos abrí el contacto → <span className="font-medium">Compartir contacto</span> →{" "}
                    <span className="font-medium">Guardar en Archivos</span>. Para varios: en la lista, arrastrá con
                    dos dedos para elegirlos, mantené apretado y compartí. Después elegí el archivo acá.
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                    <FileUp className="mr-1 size-4" /> Elegir archivo .vcf
                  </Button>
                </div>
              </div>
            )}

            {!loading && results && (
              <>
                {results.length === 0 && (
                  <p className="text-sm text-muted-foreground">Esos contactos no tienen teléfono ni email.</p>
                )}

                {users.length > 0 && (
                  <section className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">Usan La Libreta ✨ ({users.length})</h3>
                      {pendingInvites > 1 && (
                        <Button size="sm" variant="ghost" disabled={!!busy} onClick={connectAll}>
                          <Send className="mr-1 size-4" /> Invitar a todos
                        </Button>
                      )}
                    </div>
                    <div className="divide-y">
                      {users.map(({ r, i }) => {
                        const u = r.user!;
                        return (
                          <div key={i} className="flex items-center gap-3 py-2.5">
                            <Avatar className="size-10">
                              {u.photoURL && <AvatarImage src={u.photoURL} alt="" />}
                              <AvatarFallback>{initial(u.name)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold">{u.name}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {u.state === "none"
                                  ? r.name !== u.name
                                    ? `En tu agenda: ${r.name}`
                                    : "Usa La Libreta"
                                  : STATE_TEXT[u.state]}
                              </div>
                            </div>
                            {u.state === "none" ? (
                              <Button size="sm" disabled={!!busy} onClick={() => connect(i)}>
                                {busy === `c${i}` ? <Loader2 className="size-4 animate-spin" /> : <Send className="mr-1 size-4" />}
                                {busy === `c${i}` ? "" : "Invitar"}
                              </Button>
                            ) : (
                              u.state !== "self" && <Check className="size-4 text-brand" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {others.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-sm font-semibold">Todavía no usan La Libreta ({others.length})</h3>
                    <p className="text-xs text-muted-foreground">
                      Invitalos por WhatsApp o por mail, o agendalos sin app para anotarles gastos y préstamos.
                    </p>
                    <div className="divide-y">
                      {others.map(({ r, i }) => (
                        <div key={i} className="flex items-center gap-2 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{r.name}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {r.phones[0] ? formatPhone(r.phones[0]) : r.emails[0]}
                            </div>
                          </div>
                          {r.phones[0] && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Invitar a ${r.name} por WhatsApp`}
                              nativeButton={false}
                              render={
                                <a
                                  href={waMeLink(r.phones[0], inviteMessage(user?.displayName, appUrl))}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                />
                              }
                            >
                              <MessageCircle className="size-4" />
                            </Button>
                          )}
                          {r.emails[0] && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Invitar a ${r.name} por mail`}
                              disabled={!!busy}
                              onClick={() => mail(i)}
                            >
                              {busy === `m${i}` ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                            </Button>
                          )}
                          {r.offlineContactId ? (
                            <span className="flex items-center gap-1 px-2 text-xs text-muted-foreground">
                              <Check className="size-3.5" /> Agendado
                            </span>
                          ) : (
                            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => save(i)}>
                              {busy === `s${i}` ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="mr-1 size-4" />}
                              {busy === `s${i}` ? "" : "Agendar"}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <div className="flex flex-wrap gap-2 border-t pt-4">
                  {contactsManager() ? (
                    <Button type="button" size="sm" variant="outline" onClick={start}>
                      <BookUser className="mr-1 size-4" /> Elegir otros
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                      <FileUp className="mr-1 size-4" /> Otro archivo
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
