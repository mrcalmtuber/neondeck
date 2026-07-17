/**
 * Ambient declarations for modules that ship without types in this toolchain:
 *
 *  - `node:sqlite` is stable at runtime on Node 22.5+/26, but @types/node@20
 *    (pinned here) predates it. We declare the small synchronous subset we use.
 *  - `localtunnel` has no bundled types.
 *
 * These describe only what the daemon actually calls.
 */

declare module "node:sqlite" {
  type SqlValue = string | number | bigint | null | Uint8Array;

  interface StatementSync {
    all(...params: SqlValue[]): Record<string, unknown>[];
    get(...params: SqlValue[]): Record<string, unknown> | undefined;
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}

declare module "localtunnel" {
  interface Tunnel {
    url: string;
    close(): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
  }
  export default function localtunnel(opts: { port: number; host?: string }): Promise<Tunnel>;
}
