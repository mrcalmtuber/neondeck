/**
 * Client-safe error text (L3/H6). Keeps the human-readable message but strips
 * absolute filesystem paths so an unexpected error (an fs ENOENT, an OpenAI SDK
 * error, a spawn failure…) can't leak server paths / layout / internal URLs to
 * the browser.
 *
 * Lives in its own leaf module (imported by server.ts, ai.ts, agent.ts,
 * shellRun.ts) to avoid a circular import — server.ts imports agent.ts/ai.ts, so
 * those can't pull redactError back out of server.ts.
 */
export function redactError(err: unknown): string {
  const raw = String((err as { message?: string })?.message ?? err);
  return raw.replace(/\/(?:Users|home|root|app|data|var|tmp|opt|private|mnt|srv)\/[^\s'")]*/gi, "<path>");
}
