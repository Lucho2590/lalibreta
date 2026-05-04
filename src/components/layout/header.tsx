"use client";

import Link from "next/link";
import { Handshake, LogOut, Repeat, Tag, Users, Wallet } from "lucide-react";
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

export function Header({ variant = "mobile" }: { variant?: "mobile" | "desktop" }) {
  const { user } = useAuth();
  const initial = user?.email?.[0]?.toUpperCase() ?? "?";

  if (variant === "desktop") {
    return (
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-2 border-b bg-background/80 px-6 backdrop-blur">
        <MonthSelector />
        <div className="text-xs text-muted-foreground">{user?.email}</div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b bg-background/90 px-4 backdrop-blur md:hidden">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-brand-grad text-white">
          <Wallet className="size-4" strokeWidth={2.25} />
        </div>
        <MonthSelector />
      </div>
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
          <DropdownMenuItem render={<Link href="/fijos" />}>
            <Repeat className="mr-2 size-4" /> Gastos fijos
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/ingresos" />}>
            <Wallet className="mr-2 size-4" /> Ingresos
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/compartidas" />}>
            <Handshake className="mr-2 size-4" /> Compartidas
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/contactos" />}>
            <Users className="mr-2 size-4" /> Contactos
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/categorias" />}>
            <Tag className="mr-2 size-4" /> Categorías
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOut()}>
            <LogOut className="mr-2 size-4" /> Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
