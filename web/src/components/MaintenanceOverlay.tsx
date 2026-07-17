import { DEFAULT_MAINTENANCE_MESSAGE } from "@ide/shared";
import { useStore } from "../lib/store";

/**
 * MAINTENANCE (temporary — remove later).
 * Full-screen red lockout shown to NON-admins whenever an admin has flipped
 * maintenance ON. Admins are exempt and instead see a slim red banner so they
 * know it's live. Driven entirely by `store.maintenance` (pushed from the daemon
 * via `maintenance_changed`), so it flips without a reload.
 */
export function MaintenanceOverlay() {
  const isAdmin = useStore((s) => s.isAdmin);
  const maintenance = useStore((s) => s.maintenance);
  if (!maintenance.on) return null;

  if (isAdmin) {
    return (
      <div className="maint-banner" role="status">
        🛠 Maintenance mode is ON — users are locked out. You (admin) still have full access.
      </div>
    );
  }

  return (
    <div className="maint-overlay" role="alertdialog" aria-modal="true">
      <div className="maint-card">
        <div className="maint-icon">🛠</div>
        <h1>Under maintenance</h1>
        <p>{maintenance.message || DEFAULT_MAINTENANCE_MESSAGE}</p>
      </div>
    </div>
  );
}
