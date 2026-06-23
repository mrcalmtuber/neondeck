import { useState } from "react";
import { useStore, type Theme } from "../lib/store";

const THEME_LIST: { id: Theme; label: string; swatch: string }[] = [
  { id: "midnight", label: "Cyber Neon", swatch: "#0b0f19" },
  { id: "coffee", label: "Soft Pastel Coffee", swatch: "#fdfbf7" },
  { id: "dracula", label: "Dracula Dark", swatch: "#282a36" },
  { id: "contrast", label: "High-Contrast Minimalist", swatch: "#000000" },
];

/** Gear-icon theme switcher (Feature D). Repaints the whole UI via [data-theme]. */
export function ThemeMenu() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);

  return (
    <div className="theme-menu">
      <button className="btn-ghost" onClick={() => setOpen((o) => !o)} title="Theme">
        ⚙ Theme
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="theme-dropdown">
            {THEME_LIST.map((t) => (
              <button
                key={t.id}
                className={`theme-row ${theme === t.id ? "active" : ""}`}
                onClick={() => {
                  setTheme(t.id);
                  setOpen(false);
                }}
              >
                <span className="theme-swatch" style={{ background: t.swatch }} />
                {t.label}
                {theme === t.id && <span className="theme-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
