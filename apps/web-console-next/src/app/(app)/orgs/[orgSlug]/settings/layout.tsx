import * as React from "react";
import { SettingsMobileSwitcher } from "@/components/settings/settings-mobile-switcher";

/**
 * Settings content frame. The settings navigation itself lives in the left
 * sidebar (it replaces the product nav while inside `/settings`, à la Vercel),
 * so the content area is just a comfortably-wide, centered column that holds the
 * stacked settings cards. On mobile, where the sidebar is a drawer, a section
 * switcher is shown above the content.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <SettingsMobileSwitcher />
      {children}
    </div>
  );
}
