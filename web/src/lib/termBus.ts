/**
 * Tiny pub/sub so the agent loop (a non-React module) can stream tool output
 * into the Xterm panel without a direct component reference.
 */
type Sub = (data: string) => void;

class TermBus {
  private subs = new Set<Sub>();
  subscribe(fn: Sub): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  write(data: string): void {
    for (const fn of this.subs) fn(data);
  }
}

export const termBus = new TermBus();
