import OpenAI from "openai";
import type { ServerMessage } from "@ide/shared";
import type { DaemonConfig } from "./config.js";
import type { Meter } from "./usage.js";

/**
 * One-shot inline AI helpers (Feature A). These run server-side with the env
 * key — the browser only sends the selected code. Distinct from the multi-step
 * agent loop in agent.ts.
 */

function client(config: DaemonConfig): OpenAI | null {
  if (!config.deepseekApiKey) return null;
  return new OpenAI({ apiKey: config.deepseekApiKey, baseURL: config.deepseekBaseUrl });
}

const EXPLAIN_SYSTEM =
  "You explain code to beginners. Given a snippet, reply with a short, friendly, plain-English explanation of what it does. No code blocks, no jargon dumps — 2-5 sentences.";

const FIX_SYSTEM =
  "You are a careful bug-fixing assistant. The user sends a code snippet that may contain bugs or typos. Return ONLY the corrected code with the same language and structure — no explanations, no markdown code fences. If nothing is wrong, return the code unchanged.";

/** Stream a plain-English explanation as ai_delta chunks, then ai_done. */
export async function explain(
  id: string,
  code: string,
  config: DaemonConfig,
  send: (m: ServerMessage) => void,
  meter: Meter,
): Promise<void> {
  const c = client(config);
  if (!c) {
    send({ type: "error", id, message: "Neon Agent isn't configured on the daemon." });
    return send({ type: "ai_done", id });
  }
  try {
    const stream = await c.chat.completions.create({
      model: config.deepseekModel,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: EXPLAIN_SYSTEM },
        { role: "user", content: code },
      ],
    });
    let tokens = 0;
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) send({ type: "ai_delta", id, text });
      if (chunk.usage) tokens = chunk.usage.total_tokens;
    }
    meter.record(tokens);
  } catch (err) {
    send({ type: "error", id, message: (err as Error).message });
  }
  send({ type: "ai_done", id });
}

/** Ask for a corrected version and return original + fixed for a diff view. */
export async function fix(
  id: string,
  filePath: string,
  code: string,
  config: DaemonConfig,
  send: (m: ServerMessage) => void,
  meter: Meter,
): Promise<void> {
  const c = client(config);
  if (!c) {
    return send({ type: "error", id, message: "Neon Agent isn't configured on the daemon." });
  }
  try {
    const res = await c.chat.completions.create({
      model: config.deepseekModel,
      messages: [
        { role: "system", content: FIX_SYSTEM },
        { role: "user", content: code },
      ],
    });
    meter.record(res.usage?.total_tokens ?? 0);
    const fixed = stripFences(res.choices[0]?.message?.content ?? code);
    send({ type: "ai_fix_result", id, filePath, original: code, fixed });
  } catch (err) {
    send({ type: "error", id, message: (err as Error).message });
  }
}

/** Remove ```lang fences the model may add despite instructions. */
function stripFences(s: string): string {
  const fence = s.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : s;
}
