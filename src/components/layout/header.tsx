"use client";

import Link from "next/link";
import {
  ClipboardCheck,
  Handshake,
  LogOut,
  MessageCircle,
  Repeat,
  Tag,
  Users,
  Wallet,
  CalendarDays,
  CloudSun,
  ListChecks,
  Sparkles,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/firebase/auth";
import { MonthSelector } from "./month-selector";
import { NotificationBell } from "@/components/pwa/notification-bell";
import { AdminLogoTap } from "@/components/admin/admin-logo-tap";
import { openNovedades } from "@/components/novedades/novedades-dialog";

export function Header({ variant = "mobile" }: { variant?: "mobile" | "desktop" }) {
  const { user } = useAuth();
  const initial = user?.email?.[0]?.toUpperCase() ?? "?";

  if (variant === "desktop") {
    return (
      <header className="sticky top-0 z-30 hidden h-16 items-center md:flex justify-between gap-2 border-b bg-background/80 px-6 backdrop-blur">
        <MonthSelector />
        <div className="ml-auto flex items-center gap-3">
          <div className="text-xs text-muted-foreground">{user?.email}</div>
          <NotificationBell />
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b bg-background/90 px-4 backdrop-blur md:hidden">
      <div className="flex items-center gap-2">
        <AdminLogoTap>
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand-grad text-white">
            <Wallet className="size-4" strokeWidth={2.25} />
          </div>
        </AdminLogoTap>
        <MonthSelector />
      </div>
      <div className="flex items-center gap-1">
      <NotificationBell />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label="Menú" />}
        >
          <Avatar className="size-8">
            {user?.photoURL && <AvatarImage src={user.photoURL} alt="" />}
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {user?.email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link href="/agenda" />}>
            <CalendarDays className="mr-2 size-4" /> Agenda
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/listas" />}>
            <ListChecks className="mr-2 size-4" /> Listas
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/clima" />}>
            <CloudSun className="mr-2 size-4" /> Clima
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/fijos" />}>
            <Repeat className="mr-2 size-4" /> Fijos
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/ingresos" />}>
            <Wallet className="mr-2 size-4" /> Ingresos
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/compartidas" />}>
            <Handshake className="mr-2 size-4" /> Cuentas con gente
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/aprobaciones" />}>
            <ClipboardCheck className="mr-2 size-4" /> Aprobaciones
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/contactos" />}>
            <Users className="mr-2 size-4" /> Contactos
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/categorias" />}>
            <Tag className="mr-2 size-4" /> Categorías
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/whatsapp" />}>
            <MessageCircle className="mr-2 size-4" /> WhatsApp
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openNovedades()}>
            <Sparkles className="mr-2 size-4" /> Novedades
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOut()}>
            <LogOut className="mr-2 size-4" /> Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </header>
  );
}
