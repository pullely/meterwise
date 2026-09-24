"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, LogOut, User2, ShieldCheck, Sun, Moon } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { initials } from "@/components/account/profile";
import { cn } from "@/lib/cn";

/**
 * Vercel-style account chip anchored at the bottom of the sidebar: avatar +
 * display name + email, opening the account menu (Profile, Security activity,
 * theme, Logout). This is the single home for the signed-in identity on desktop
 * — the topbar account icon is hidden there.
 */
export function SidebarAccount() {
  const router = useRouter();
  const { client, setToken } = useSession();
  const { theme, setTheme } = useTheme();
  const profile = useApiQuery(qk.profile(), () =>
    wrap(async () => (await client.auth.getProfile()).user),
  );
  const user = profile.data;

  if (profile.loading && !user) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Skeleton className="h-7 w-7 rounded-full" />
        <div className="flex-1 space-y-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2.5 w-32" />
        </div>
      </div>
    );
  }

  const name = user?.displayName || user?.email?.split("@")[0] || "Account";
  const email = user?.email ?? "";
  const seed = user ? initials(user.displayName ?? null, user.email) : "?";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
          "hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary/40 text-[11px] font-bold text-primary-foreground">
          {seed}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium leading-tight">{name}</span>
          {email && email !== name && (
            <span className="truncate text-[11px] leading-tight text-muted-foreground">{email}</span>
          )}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[220px]">
        {email && <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>}
        <DropdownMenuItem onSelect={() => router.push("/account")}>
          <User2 className="h-4 w-4 opacity-70" /> Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/account/security")}>
          <ShieldCheck className="h-4 w-4 opacity-70" /> Security activity
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setTheme(theme === "dark" ? "light" : "dark");
          }}
        >
          {theme === "dark" ? <Sun className="h-4 w-4 opacity-70" /> : <Moon className="h-4 w-4 opacity-70" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setToken(null);
            router.push("/login");
          }}
        >
          <LogOut className="h-4 w-4 opacity-70" /> Logout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
