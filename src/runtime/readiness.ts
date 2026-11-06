// Readiness registry.
// Anything that must finish before a frame may be captured (fonts, an image
// decoding, a video seeking) holds a handle until it is done. The render page
// waits for the registry to drain after every seek; the Player reports it as
// buffering ('waiting' / 'resume').

export type ReadyHandle = number;

export class Readiness {
  private pending = new Map<ReadyHandle, string>();
  private next = 1;
  private listeners = new Set<() => void>();
  private failure: Error | null = null;

  delayRender = (label = 'delayRender'): ReadyHandle => {
    const handle = this.next++;
    this.pending.set(handle, label);
    if (this.pending.size === 1) this.emit();
    return handle;
  };

  continueRender = (handle: ReadyHandle): void => {
    if (!this.pending.delete(handle)) return;
    if (this.pending.size === 0) this.emit();
  };

  /** Stop: the render page rejects the frame it is waiting on with this error. */
  cancelRender = (err: unknown): void => {
    this.failure = err instanceof Error ? err : new Error(String(err));
    this.emit();
  };

  get busy(): boolean {
    return this.pending.size > 0;
  }

  get error(): Error | null {
    return this.failure;
  }

  /** Labels still pending (for timeout messages). */
  labels(): string[] {
    return [...this.pending.values()];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Resolves once nothing is pending (rejects on cancelRender or timeout). */
  settled(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.failure) return done(this.failure);
        if (!this.busy) return done(null);
      };
      const timer = setTimeout(() => done(new Error(`Timed out after ${timeoutMs / 1000}s waiting for: ${this.labels().join(', ') || 'unknown'}`)), timeoutMs);
      const unsubscribe = this.subscribe(check);
      function done(err: Error | null) {
        clearTimeout(timer);
        unsubscribe();
        if (err) reject(err);
        else resolve();
      }
      check();
    });
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }
}

/** Fallback for trees rendered outside any host (tests, static markup). */
export const globalReadiness = new Readiness();
