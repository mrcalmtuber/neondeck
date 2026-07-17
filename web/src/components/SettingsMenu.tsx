import { getTier } from "@ide/shared";
import { useStore } from "../lib/store";

/**
 * Bottom-left account / settings launcher. Clicking it opens the full **Settings
 * page** (its left-nav sections are the "bunch of stuff") — not a pop-up. Two
 * placements share the component:
 *   • `variant="statusbar"` (default) — the IDE status bar, a horizontal chip.
 *   • `variant="rail"` — the Dashboard's left sidebar, a vertical avatar.
 */
export function SettingsMenu({ variant = "statusbar" }: { variant?: "statusbar" | "rail" }) {
  const setView = useStore((s) => s.setView);
  const setSettingsSection = useStore((s) => s.setSettingsSection);
  const session = useStore((s) => s.session);
  const authMode = useStore((s) => s.authMode);
  const tier = useStore((s) => s.tier());

  const cfg = getTier(tier);
  const email = session?.email ?? "developer@kryct.io";
  const initial = (email[0] ?? "•").toUpperCase();
  const tierLabel = authMode === "dev" ? "Dev" : cfg.name;

  function openSettings() {
    setSettingsSection("account");
    setView("settings");
  }

  return (
    <div className={`settings-menu ${variant}`}>
      <button className="settings-menu-trigger" onClick={openSettings} title="Open settings">
        <span className={`profile-avatar${variant === "statusbar" ? " sm" : ""}`}>{initial}</span>
        {variant === "statusbar" && <span className="settings-menu-trigger-label">{tierLabel}</span>}
        <span className="settings-menu-cog">⚙</span>
      </button>
    </div>
  );
}
