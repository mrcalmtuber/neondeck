/**
 * White-label brand strings. The UI never names the underlying AI provider or
 * model — everything references the platform's own agent brand. Change these in
 * one place to re-skin the product.
 */
export const PLATFORM_NAME = "NeonDeck";
/** Neon diamond brand mark shown beside the platform name. */
export const BRAND_MARK = "◆";
/** Convenience: mark + name, e.g. "◆ NeonDeck". */
export const BRAND_LABEL = `${BRAND_MARK} ${PLATFORM_NAME}`;
/** User-facing name for the platform's AI agent (never the underlying model). */
export const AGENT_NAME = "Neon Agent";
export const PLATFORM_AGENT = "Neon Agent";
/** Neutral env var the setup UI tells users to set (aliased daemon-side). */
export const AGENT_KEY_ENV = "AGENT_API_KEY";
