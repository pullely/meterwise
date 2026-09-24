"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Sun, Moon, LogOut, User2, Building2, Command as CommandIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { ScopeSwitcher } from "./scope-switcher";
import { MobileNav } from "./mobile-nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session";
import { usePalette } from "./command-palette";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

export function Topbar() {
  const { token, target, isLocked, setToken } = useSession();
  const palette = usePalette();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md pt-safe">
      <div className="flex h-12 items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <MobileNav />
        <ScopeSwitcher />

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {/* Search lives in the sidebar "Find…" on desktop; the topbar keeps a
              search affordance only on small screens (no sidebar there). */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => palette.open()}
            aria-label="Search"
            className="h-10 w-10 justify-center px-0 sm:h-8 sm:w-auto sm:justify-start sm:gap-2 sm:px-3 md:hidden"
          >
            <Search className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            <span className="hidden text-xs text-muted-foreground sm:inline">Search…</span>
            <kbd className="hidden items-center gap-1 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline-flex">
              <CommandIcon className="h-3 w-3" /> K
            </kbd>
          </Button>

          <Badge variant={isLocked ? "secondary" : "outline"} className="hidden lg:inline-flex">
            {isLocked ? `locked · ${target.name}` : `target · ${target.name}`}
          </Badge>

          {/* Theme toggle lives in the profile menu (sidebar account chip on
              desktop; account menu / drawer on mobile), not the topbar. */}

          {/* Account lives in the sidebar chip on desktop; the topbar account
              menu is mobile-only (the sidebar is a drawer there). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Account menu"
                className="h-10 w-10 sm:h-9 sm:w-9 md:hidden"
              >
                <User2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
              <DropdownMenuLabel>Account</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => router.push("/account")}>
                <User2 className="h-4 w-4 opacity-70" /> Profile
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push("/orgs")}>
                <Building2 className="h-4 w-4 opacity-70" /> Organizations
              </DropdownMenuItem>
              {/* Theme toggle — this account menu is the mobile theme control. */}
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  toggleTheme();
                }}
              >
                {theme === "dark" ? (
                  <Sun className="h-4 w-4 opacity-70" />
                ) : (
                  <Moon className="h-4 w-4 opacity-70" />
                )}
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
              {!token && (
                <DropdownMenuItem onSelect={() => router.push("/login")}>Sign in</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
