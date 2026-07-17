import type { ReactNode } from "react";

/**
 * Hoverable question-mark tooltip for beginner-facing jargon
 * ("Docker Sandboxing", "Iframe Proxy", "Context Caching", …).
 */
export function InfoTip({ term, children }: { term: string; children: ReactNode }) {
  return (
    <span className="infotip">
      <span className="infotip-q" tabIndex={0} aria-label={`What is ${term}?`}>
        ?
      </span>
      <span className="infotip-bubble" role="tooltip">
        <strong>{term}</strong>
        <br />
        {children}
      </span>
    </span>
  );
}
