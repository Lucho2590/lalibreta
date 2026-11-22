"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useContacts } from "@/hooks/use-data";
import { ContactForm } from "@/components/contacts/contact-form";
import { ensureAppContact } from "@/lib/domain/contacts";
import { contactDisplayName } from "@/lib/domain/contact-info";

export type EditContactTarget =
  | { contactId: string }
  | { appUser: { uid: string; email: string; displayName: string | null; photoURL: string | null } };

/**
 * Hoja para editar la ficha de alguien. A los conectados que todavía no
 * tienen contacto (conexiones viejas) se lo crea al abrir.
 */
export function EditContactSheet({
  target,
  onClose,
}: {
  target: EditContactTarget | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { data: contacts } = useContacts();
  const creating = useRef<string | null>(null);

  const contact = !target
    ? null
    : "contactId" in target
      ? (contacts.find((c) => c.id === target.contactId) ?? null)
      : (contacts.find((c) => c.linkedUid === target.appUser.uid) ?? null);

  const appUser = target && "appUser" in target ? target.appUser : null;
  useEffect(() => {
    if (!user || !appUser || contact || creating.current === appUser.uid) return;
    creating.current = appUser.uid;
    ensureAppContact(user.uid, appUser).catch((err) => {
      console.error(err);
      toast.error("No se pudo abrir la ficha");
      onClose();
    });
  }, [user, appUser, contact, onClose]);

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="sheet-md-modal max-h-[92vh] overflow-y-auto p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>{contact ? contactDisplayName(contact) : "Contacto"}</SheetTitle>
        </SheetHeader>
        <div className="px-5 pb-6 pt-3">
          {contact ? (
            <ContactForm key={contact.id} contact={contact} onSaved={onClose} />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
