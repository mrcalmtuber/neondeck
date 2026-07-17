/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Neutral, white-labeled agent endpoint vars (no provider name leaked). */
  readonly VITE_AGENT_BASE_URL?: string;
  readonly VITE_AGENT_MODEL?: string;
  /** Optional Firebase overrides — the live config is hardcoded in
   *  web/src/lib/firebaseClient.ts; these only override a single field. */
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  /** Remote Kryct daemon WS endpoint, e.g. "wss://node.kryct.io". */
  readonly VITE_DAEMON_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
