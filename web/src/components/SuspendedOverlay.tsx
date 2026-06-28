import { useStore } from "../lib/store";

/**
 * Per-user suspension lockout. Full-screen "you have been suspended" screen shown to
 * a NON-admin whose account an admin has suspended (with an optional custom message).
 * Admins are exempt so the owner can't lock themselves out of the admin panel.
 * Driven by `store.suspended` (from hello + live `suspension_changed` pushes), so it
 * flips without a reload.
 */
export function SuspendedOverlay() {
  const isAdmin = useStore((s) => s.isAdmin);
  const suspended = useStore((s) => s.suspended);
  const message = useStore((s) => s.suspendMessage);
  if (!suspended || isAdmin) return null;

  return (
    <div className="maint-overlay" role="alertdialog" aria-modal="true">
      <div className="maint-card">
        <div className="maint-icon">🚫</div>
        <h1>You have been suspended</h1>
        <p>
          {message ||
            "Your access to NeonDeck has been suspended. If you think this is a mistake, please contact support."}
        </p>
      </div>
    </div>
  );
}
