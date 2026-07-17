import type { ErrorBanner } from "./store";

/** Compile/syntax failure signatures (kept beginner-simple, not exhaustive). */
const ERROR_SIGNALS =
  /(SyntaxError|Unexpected token|Unexpected end of input|error TS\d+|Failed to compile|Module not found|Cannot find module|ParseError|Unterminated string)/i;

/** Build-success / recovery signatures that clear the banner. */
const OK_SIGNALS = /compiled successfully|webpack compiled|ready in \d|hmr update|hot updated|no errors/i;

/**
 * Scan a chunk of build-log text and decide what the traffic-light banner
 * should show. Returns:
 *   - ErrorBanner  → switch to red "Code Construction Paused"
 *   - null         → clear the banner (build is healthy again)
 *   - undefined    → no signal in this chunk; leave the banner as-is
 */
export function classifyLog(chunk: string): ErrorBanner | null | undefined {
  if (ERROR_SIGNALS.test(chunk)) {
    const line = extractLine(chunk);
    return {
      message: line
        ? `Code Construction Paused: Typo or missing character on line ${line}`
        : "Code Construction Paused: there's a typo or missing character in your code",
      line,
    };
  }
  if (OK_SIGNALS.test(chunk)) return null;
  return undefined;
}

/** Best-effort line-number extraction from common error formats. */
function extractLine(chunk: string): string | undefined {
  const named = chunk.match(/line[ :]+(\d+)/i);
  if (named) return named[1];
  const colon = chunk.match(/:(\d+):\d+/); // file.js:12:5
  if (colon) return colon[1];
  const paren = chunk.match(/\((\d+),\s*\d+\)/); // (12,5)
  if (paren) return paren[1];
  return undefined;
}
