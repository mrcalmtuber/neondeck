import { useStore } from "../lib/store";
import { provisionTemplate } from "../lib/provision";
import { TEMPLATES, type Template } from "../lib/templates";

/**
 * "NeonDeck Template Hub" — a sliding overlay opened by the 🏠 Home button.
 *
 * Seeds the in-browser workspace with one of 12 beginner sandboxes and drops the
 * user straight into a live preview. Pure front-end: no daemon, no build step.
 */
export function TemplateHub() {
  const open = useStore((s) => s.templateHubOpen);
  const setOpen = useStore((s) => s.setTemplateHubOpen);

  function launch(t: Template) {
    provisionTemplate(t); // shared scaffold-and-open path (also used by the Dashboard)
    useStore.getState().setTemplateHubOpen(false);
  }

  if (!open) return null;

  return (
    <div className="template-hub-backdrop" onClick={() => setOpen(false)}>
      <div className="template-hub" onClick={(e) => e.stopPropagation()}>
        <div className="template-hub-head">
          <div>
            <h2>◆ NeonDeck Template Hub</h2>
            <p className="muted">Pick a starter and we'll spin up a live sandbox instantly.</p>
          </div>
          <button className="icon-btn close-hub" onClick={() => setOpen(false)} title="Close">
            ✕
          </button>
        </div>

        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <div key={t.id} className="template-card glass">
              <span className="template-emoji">{t.emoji}</span>
              <span className="template-title">{t.title}</span>
              <span className="template-desc muted">{t.desc}</span>
              <button className="launch-btn" onClick={() => launch(t)}>
                Launch Sandbox →
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
