/**
 * White-label brand strings. The UI never names the underlying AI provider or
 * model — everything references the platform's own agent brand. Change these in
 * one place to re-skin the product.
 *
 * Kryct (/krikt/) — the wordmark always renders as wide-tracked caps ("KRYCT");
 * BRAND_LABEL is pre-uppercased so every usage is on-brand even without the
 * .wordmark CSS treatment. No glyph/mark: the identity is the bare wordmark.
 */
export const PLATFORM_NAME = "Kryct";
/** No brand glyph — Kryct is a pure text wordmark. Kept for API compat. */
export const BRAND_MARK = "";
/** The wordmark as displayed: uppercase (CSS adds the wide letter-spacing). */
export const BRAND_LABEL = PLATFORM_NAME.toUpperCase();
/** User-facing name for the platform's AI agent (never the underlying model). */
export const AGENT_NAME = "Kryct Agent";
export const PLATFORM_AGENT = "Kryct Agent";
/** Neutral env var the setup UI tells users to set (aliased daemon-side). */
export const AGENT_KEY_ENV = "AGENT_API_KEY";
/** Public support inbox (suspension appeals, contact links, legal pages). */
export const SUPPORT_EMAIL = "support@kryct.com";
/** Displayed app version (Settings → About). Bump on notable releases. */
export const APP_VERSION = "1.0";
